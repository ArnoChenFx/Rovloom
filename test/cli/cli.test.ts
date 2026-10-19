// 使用临时配置、内存流和真实 Bun bundle 验证 CLI 拒绝、脱敏与关闭行为，不启动生产后端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import {
  configTemplate,
  parseConfig,
  readConfig,
  runCli,
  type CliRuntime,
  type GatewayConfig
} from '../../src/cli/index.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const marker = 'SYNTHETIC_SECRET_DO_NOT_PRINT'

// 为单个测试分配私有临时目录，并在成功或失败后统一删除。
function temporary(check: (directory: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-cli-test-'))
  return Promise.resolve()
    .then(/* 在目录已建立后运行本例检查，接住同步和异步失败。 */ () => check(directory))
    .finally(
      /* 清理本例拥有的目录，不保留配置或构建临时文件。 */ () => rmSync(directory, { recursive: true, force: true })
    )
}

// 在私有目录写入无密钥角色配置，供只读解析和启动拒绝测试使用。
function configFile(directory: string, role: 'gateway' | 'connector' = 'gateway') {
  const path = join(directory, `${role}.json`)
  const config = { ...configTemplate(role), state_dir: join(directory, 'state') }
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  return path
}

// 用内存流捕获命令输出和退出码，EOF 用于触发本地关闭路径。
async function capture(args: string[], runtime?: CliRuntime, stop = new AbortController()) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on(
    'data',
    /* 收集标准输出，供断言协议通道没有混入诊断。 */ (chunk) => {
      out += chunk
    }
  )
  stderr.on(
    'data',
    /* 收集标准错误，供核对稳定代码且无输入值反射。 */ (chunk) => {
      err += chunk
    }
  )
  const running = runCli(args, { stdin, stdout, stderr, signal: stop.signal }, runtime)
  stdin.end()
  return { code: await running, stdout: out, stderr: err }
}

test(
  '严格配置拒绝 secret、URL 身份、隐式相对路径和角色字段混用，模板无密钥',
  /* 组合秘密字段、路径和 URL 负例，检查模板与严格解析边界。 */ () => {
    for (const role of ['gateway', 'connector'] as const) {
      const template = configTemplate(role)
      assert.equal(parseConfig(template).role, role)
      assert(Object.isFrozen(template))
      for (const extra of [{ secret: marker }, { token: marker }, { principal_id: 'admin' }, { binary: '/bin/sh' }]) {
        assert.throws(
          /* 提交未声明字段，确认配置不能接纳额外身份或秘密。 */ () => parseConfig({ ...template, ...extra })
        )
      }
      for (const state_dir of ['relative', '~/state', '/tmp/../state', '/tmp//state', '/']) {
        assert.throws(/* 提交非规范状态路径，确认解析不依赖隐式展开。 */ () => parseConfig({ ...template, state_dir }))
      }
    }
    const connector = configTemplate('connector')
    for (const gateway_url of [
      `wss://user:${marker}@localhost:9443`,
      `wss://localhost:9443/?token=${marker}`,
      `wss://localhost:9443/#${marker}`,
      `wss://localhost:9443/${marker}`,
      'ws://localhost:9443',
      'https://localhost:9443',
      'wss://localhost:9443?'
    ]) {
      assert.throws(/* 提交携带凭据或额外路径的 URL，确认其被拒绝。 */ () => parseConfig({ ...connector, gateway_url }))
    }
    assert.throws(
      /* 提交重复 provider 引用，确认配置不会产生歧义绑定。 */ () =>
        parseConfig({ ...connector, provider_config_refs: ['same', 'same'] })
    )
    assert.throws(
      /* 将本地路径伪装成引用，确认不会变成模块加载入口。 */ () =>
        parseConfig({ ...connector, provider_config_refs: ['/private/provider'] })
    )
  }
)

test(
  '只读配置使用受保护 regular file 和有界 descriptor，拒绝 symlink 及宽松权限',
  { timeout: 30_000 },
  /* 在隔离文件系统中验证最终文件类型、权限、编码与大小限制。 */ async () => {
    await temporary(
      /* 依次改变配置权限和内容，确认只读加载失败且不改写文件。 */ (directory) => {
        const path = configFile(directory)
        assert.equal(readConfig(path).role, 'gateway')
        chmodSync(path, 0o644)
        assert.throws(/* 读取宽松权限文件，核对配置保护门禁。 */ () => readConfig(path), /Rovloom command failed/)
        chmodSync(path, 0o600)
        const link = join(directory, 'link.json')
        symlinkSync(path, link)
        assert.throws(/* 读取最终符号链接，核对 descriptor 不跟随链接。 */ () => readConfig(link))
        chmodSync(directory, 0o755)
        assert.throws(/* 读取宽松父目录中的配置，核对目录保护门禁。 */ () => readConfig(path))
        chmodSync(directory, 0o700)
        writeFileSync(path, 'x'.repeat(16_385))
        assert.throws(/* 读取超大文件，确认不会无界收集配置内容。 */ () => readConfig(path))
        writeFileSync(path, Buffer.from([0xff]))
        assert.throws(/* 读取非法 UTF-8 配置，确认不会替换字符后继续使用。 */ () => readConfig(path))
      }
    )
  }
)

test(
  'help、配置检查和缺后端退出码明确；所有非法命令及异常均不回显秘密',
  { timeout: 30_000 },
  /* 覆盖命令解析、缺后端退出码和错误脱敏，避免假成功。 */ async () => {
    await temporary(
      /* 使用同一隔离配置逐项检查帮助、角色拒绝和模板输出。 */ async (directory) => {
        const path = configFile(directory)
        for (const args of [[], ['--help'], ['gateway', '--help'], ['connector', '--help'], ['--version']]) {
          const result = await capture(args)
          assert.equal(result.code, 0)
          assert.equal(result.stdout, '')
          assert(result.stderr.includes('Rovloom'))
        }
        assert.deepEqual(await capture(['config', 'check', '--config', path]), {
          code: 0,
          stdout: '',
          stderr: 'config_valid\n'
        })
        assert.deepEqual(await capture(['gateway', '--config', path]), {
          code: 3,
          stdout: '',
          stderr: 'backend_unavailable\n'
        })
        const connector = configFile(directory, 'connector')
        assert.deepEqual(await capture(['connector', '--config', connector]), {
          code: 3,
          stdout: '',
          stderr: 'backend_unavailable\n'
        })
        assert.equal((await capture(['connector', '--config', path])).code, 2)
        for (const args of [
          ['pair', marker],
          ['gateway', '--token', marker],
          ['connector', '--enrollment', marker],
          ['gateway', '--config', path, '--help'],
          ['gateway', '--config', `${path}/${marker}`]
        ]) {
          const result = await capture(args)
          assert.equal(result.code, 2)
          assert.equal(result.stdout, '')
          assert(!result.stderr.includes(marker))
          assert(!result.stderr.includes(directory))
        }
        const failure = await capture(['gateway', '--config', path], {
          gateway: /* 让宿主抛出含合成秘密的异常，检验 CLI 只输出固定错误码。 */ async () => {
            throw new Error(`${marker} /private/backend`)
          }
        })
        assert.deepEqual(failure, { code: 1, stdout: '', stderr: 'runtime_failed\n' })
        const template = await capture(['config', 'template', 'gateway'])
        assert.equal(template.code, 0)
        assert.deepEqual(JSON.parse(template.stdout), configTemplate('gateway'))
        assert.equal(template.stderr, '')
      }
    )
  }
)

test(
  '注入角色仅使用固定配置；EOF不停止Gateway，终止信号关闭资源，失败关闭不报告成功',
  { timeout: 30_000 },
  /* 验证注入角色的持久HTTP、终止信号和失败关闭语义，不启动真实服务。 */ async () => {
    await temporary(
      /* 在临时配置下记录两角色清理次数，检查关闭幂等和错误传播。 */ async (directory) => {
        const path = configFile(directory)
        let closed = 0
        const gatewayStop = new AbortController()
        const result = await capture(
          ['gateway', '--config', path],
          {
            gateway: /* 检查 Gateway 收到固定配置，并提供仅供生命周期测试的宿主。 */ async (config: GatewayConfig) => {
              assert.equal(config.authentication_ref, 'mcp-http')
              return {
                // 仅测试生命周期的 stub，不提供任何成功的业务动作。
                service: {
                  execute: /* 禁止本例执行任何业务动作，避免关闭测试伪装后端成功。 */ async () => {
                    throw new Error('unused_stub')
                  }
                },
                authentication: { authenticate: /* 拒绝全部HTTP身份，生命周期测试无法获得业务权限。 */ () => null },
                listening: /* stdin已EOF仍必须持续监听，只有显式宿主终止才结束角色。 */ () => {
                  assert.equal(closed, 0)
                  gatewayStop.abort()
                },
                close: /* 记录 Gateway 资源释放次数，核对 EOF 清理只发生一次。 */ async () => {
                  closed++
                }
              }
            }
          },
          gatewayStop
        )
        assert.deepEqual(result, { code: 0, stdout: '', stderr: '' })
        assert.equal(closed, 1)
        const stop = new AbortController()
        const connector = configFile(directory, 'connector')
        let connectorClosed = 0
        const stopped = await capture(
          ['connector', '--config', connector],
          {
            connector: /* 在 Connector 启动后立即触发终止信号，验证宿主仍会关闭。 */ async () => {
              stop.abort()
              return {
                closed: new Promise<void>(/* 保持运行完成信号待定，使本例只能由终止信号结束等待。 */ () => {}),
                close: /* 记录 Connector 关闭次数，核对取消等待没有漏掉资源释放。 */ async () => {
                  connectorClosed++
                }
              }
            }
          },
          stop
        )
        assert.equal(stopped.code, 0)
        assert.equal(connectorClosed, 1)
        const failure = await capture(['connector', '--config', connector], {
          connector: /* 提供已结束的 Connector，再让关闭失败，以检查失败退出码。 */ async () => ({
            closed: Promise.resolve(),
            close: /* 抛出合成秘密异常，确认关闭失败不会泄露原始消息。 */ async () => {
              throw new Error(marker)
            }
          })
        })
        assert.deepEqual(failure, { code: 1, stdout: '', stderr: 'runtime_failed\n' })
      }
    )
  }
)

test(
  '同一 Bun bundle 提供两个角色及 help/config；独立产物缺后端不会伪装成功',
  { timeout: 30_000 },
  /* 构建一个独立 bundle，证明两个角色共用入口且缺后端时拒绝。 */ async () => {
    await temporary(
      /* 在临时目录构建并启动产物，不依赖源码路径下的运行入口。 */ (directory) => {
        const artifact = join(directory, 'rovloom.js')
        const build = spawnSync(
          process.execPath,
          ['--no-env-file', 'build', 'src/cli/main.ts', '--target=bun', '--outfile', artifact],
          {
            cwd: repo,
            encoding: 'utf8',
            timeout: 30_000,
            env: { PATH: process.env.PATH ?? '' }
          }
        )
        assert.equal(build.status, 0, build.stdout + build.stderr)
        const run = /* 以最小环境运行同一 bundle，收集真实子进程退出码与输出。 */ (args: string[]) =>
          spawnSync(process.execPath, ['--no-env-file', artifact, ...args], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 5000,
            env: { PATH: process.env.PATH ?? '' }
          })
        assert.match(run(['--help']).stderr, /Rovloom/)
        const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
        assert.equal(run(['--version']).stderr, `Rovloom ${manifest.version}\n`)
        for (const role of ['gateway', 'connector'] as const) {
          const template = run(['config', 'template', role])
          assert.equal(template.status, 0)
          assert.deepEqual(JSON.parse(template.stdout), configTemplate(role))
          const result = run([role, '--config', configFile(directory, role)])
          assert.equal(result.status, 3)
          assert.equal(result.stdout, '')
          assert.equal(result.stderr, 'backend_unavailable\n')
        }
      }
    )
  }
)
