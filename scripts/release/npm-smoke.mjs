/** 在干净目录用 bun add 安装 Release 的 npm tarball，核对 CLI、bunx 入口、非 Bun 运行时拒绝和真实 Gateway 起停。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadManagementAssets } from '../../src/admin/assets.ts'
import { smokeGatewayProduct } from './gateway-smoke.mjs'
import { cleanupSmokeDirectory, runSmokeChild } from './smoke-process.mjs'

/** 安装和 bunx 需要访问 npm 注册表拉取运行时依赖（@modelcontextprotocol/sdk、ajv），其余检查全部本地。 */
function install(tarball, directory, env) {
  const result = spawnSync(process.execPath, ['--no-env-file', 'add', tarball], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 180_000
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `bun add failed: ${result.stderr}`)
}

/** 已安装包的固定入口与 bin 链接；Windows 的 .bin 是 shim，不做文件类型假设。 */
function binShim(directory) {
  const base = join(directory, 'node_modules', '.bin')
  const candidates = process.platform === 'win32' ? ['rovloom.exe', 'rovloom.cmd', 'rovloom'] : ['rovloom']
  const found = candidates.map((name) => join(base, name)).find((path) => existsSync(path))
  assert(found, 'rovloom bin shim missing')
  return found
}

export async function smokeNpm(tarball, version, options = {}) {
  tarball = resolve(tarball)
  assert(lstatSync(tarball).isFile(), 'npm_tarball_required')
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version), 'npm_smoke_version_required')
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const root = mkdtempSync(join(tmpdir(), 'rovloom-npm-'))
  try {
    const project = join(root, 'project')
    const home = join(root, 'home')
    const cwd = join(root, 'cwd')
    for (const path of [project, home, cwd]) {
      mkdirSync(path)
    }
    const bunDirectory = dirname(process.execPath)
    // 仅 bun 所在目录在 PATH 上（bin shim 的 #!/usr/bin/env bun 需要）；不继承其它用户环境。
    const env = {
      PATH: bunDirectory,
      HOME: home,
      TMPDIR: root,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      ...(process.platform === 'win32'
        ? { USERPROFILE: home, TEMP: root, TMP: root, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
        : {})
    }
    await Bun.write(join(project, 'package.json'), '{"name":"rovloom-npm-smoke","private":true}\n')
    install(tarball, project, env)
    const installed = join(project, 'node_modules', 'rovloom')
    const entry = join(installed, 'dist', 'src', 'cli', 'main.js')
    assert(lstatSync(entry).isFile(), 'installed CLI entry missing')
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.scripts, undefined)
    assert.equal(manifest.devDependencies, undefined)
    for (const dependency of ['@modelcontextprotocol/sdk', 'ajv']) {
      assert(existsSync(join(project, 'node_modules', dependency, 'package.json')), `dependency missing: ${dependency}`)
    }

    // 通过 bin shim 运行，等同用户在 PATH 上使用 rovloom 命令。
    const shim = binShim(project)
    const checks = [
      {
        args: ['--version'],
        code: 0,
        stdout: /^$/u,
        stderr: new RegExp(`^Rovloom ${version.replaceAll('.', '\\.')}\\r?\\n$`, 'u')
      },
      { args: ['--help'], code: 0, stdout: /^$/u, stderr: /Rovloom/u },
      { args: ['config', 'template', 'gateway'], code: 0, stdout: /"role": "gateway"/u, stderr: /^$/u },
      { args: ['--invalid-packaging-smoke'], code: 2, stdout: /^$/u, stderr: /^invalid_arguments\r?\n$/u }
    ]
    for (const check of checks) {
      const result = await runSmokeChild(shim, check.args, { cwd, env })
      assert.equal(result.signal, null)
      assert.equal(result.status, check.code, `Unexpected exit for ${JSON.stringify(check.args)}: ${result.stderr}`)
      assert.match(result.stdout, check.stdout)
      assert.match(result.stderr, check.stderr)
    }

    // config check 读模板写出的真实配置文件。
    const template = await runSmokeChild(shim, ['config', 'template', 'gateway'], { cwd, env })
    const config = join(root, 'gateway.json')
    await Bun.write(config, template.stdout)
    const checked = await runSmokeChild(shim, ['config', 'check', '--role', 'gateway', '--config', config], {
      cwd,
      env
    })
    assert.equal(checked.status, 0, `config check failed: ${checked.stderr}`)
    assert.match(checked.stderr, /config_valid/u)

    // 非 Bun 运行时必须给出明确提示（环境中没有 node 时跳过，不影响其它验收）。
    const node = spawnSync('node', ['--version'], { encoding: 'utf8' })
    if (node.status === 0) {
      const refused = await runSmokeChild('node', [entry, '--version'], {
        cwd,
        env: { ...env, PATH: process.env.PATH }
      })
      assert.equal(refused.status, 1)
      assert.match(refused.stderr, /requires Bun/u)
    }

    // bunx 直接从 tarball 运行（Release 页面给出的用法），不依赖已有安装。
    if (!options.skipBunx) {
      const via = await runSmokeChild(
        process.execPath,
        ['--no-env-file', 'x', '--package', tarball, 'rovloom', '--version'],
        {
          cwd,
          env
        }
      )
      assert.equal(via.status, 0, `bunx failed: ${via.stderr}`)
      assert.match(via.stderr, new RegExp(`Rovloom ${version.replaceAll('.', '\\.')}`, 'u'))
    }

    // 真实 Gateway：由 bun 直接运行已安装入口，核对内嵌管理页资源、MCP 与 schema Worker，并正常关闭。
    const gateway = await smokeGatewayProduct(
      process.execPath,
      version,
      loadManagementAssets(resolve(options.webui ?? 'dist/webui')),
      { entry, identity: digest }
    )
    assert.equal(gateway.product_sha256, digest)
    assert.deepEqual(gateway.schemaFactories, ['luvus', 'herdr'])
    return { scope: 'npm-package', platform: `${process.platform}-${process.arch}`, version, tarball_sha256: digest }
  } finally {
    await cleanupSmokeDirectory(root)
  }
}

if (import.meta.main) {
  const [tarball, version] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, 'Usage: bun scripts/release/npm-smoke.mjs /path/rovloom-<version>.tgz <version>')
  console.log(JSON.stringify(await smokeNpm(tarball, version)))
}
