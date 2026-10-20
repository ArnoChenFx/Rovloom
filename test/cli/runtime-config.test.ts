// 只读产品配置命令使用真实私有文件；不连接provider、创建凭据或把结构有效当作业务就绪。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { configTemplate, parseConfig, parseRuntimeConfig, runCli, type CliRuntime } from '../../src/cli/index.js'

// 收集真实CLI命令的流，宿主回调只有错误探针，不能为配置检查制造后端成功。
async function capture(args: string[], runtime: CliRuntime = {}) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', /* 模板可以写stdout，检查结果只进stderr。 */ (chunk) => (out += chunk))
  stderr.on('data', /* 不输出文件内容、秘密或底层异常。 */ (chunk) => (err += chunk))
  const code = await runCli(
    args,
    {
      stdin: new PassThrough(),
      stdout,
      stderr,
      signal: new AbortController().signal
    },
    runtime
  )
  return { code, stdout: out, stderr: err }
}

test(
  'runtime模板可由唯一CLI离线消费，双角色只读检查不打开DB或宿主',
  /* 两份真实描述与其角色模板配套，测试目录不含caller、凭据或TLS文件。 */ async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-runtime-config-'))
    try {
      for (const role of ['gateway', 'connector'] as const) {
        const result = await capture(['config', 'template', 'runtime', role])
        assert.equal(result.code, 0)
        assert.equal(result.stderr, '')
        const runtime = JSON.parse(result.stdout)
        const path = join(root, 'role.json')
        const config = parseConfig({ ...configTemplate(role), state_dir: root })
        writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
        writeFileSync(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
        const unexpected = /* 检查不能建立实际角色或访问其凭据。 */ async () => assert.fail('role was started')
        assert.deepEqual(
          await capture(['config', 'check-runtime', '--config', path], {
            gateway: unexpected,
            connector: unexpected
          }),
          process.platform === 'linux'
            ? { code: 0, stdout: '', stderr: 'runtime_config_valid\n' }
            : { code: 2, stdout: '', stderr: 'config_platform_unsupported\n' }
        )
        assert.deepEqual(readdirSync(root).sort(), ['role.json', 'runtime.json'])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'runtime检查共用启动校验器，冲突引用和额外秘密只返回固定错误',
  /* 从真实命令输入验证角色/runtime错配，不能仅检查新模板自身。 */ async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-runtime-config-'))
    try {
      const path = join(root, 'role.json')
      const config = parseConfig({ ...configTemplate('gateway'), state_dir: root })
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
      const template = JSON.parse((await capture(['config', 'template', 'runtime', 'gateway'])).stdout)
      for (const changed of [
        { authentication_ref: 'another' },
        { secret: 'SYNTHETIC_SECRET_DO_NOT_PRINT' },
        { provider_config_refs: ['../private'] },
        { role: 'connector' }
      ]) {
        const value = { ...template, ...changed }
        assert.throws(/* 纯字段校验全平台执行，私有读取仍保留现行平台边界。 */ () => parseRuntimeConfig(value, config))
        writeFileSync(join(root, 'runtime.json'), JSON.stringify(value), { mode: 0o600 })
        assert.deepEqual(await capture(['config', 'check-runtime', '--config', path]), {
          code: 2,
          stdout: '',
          stderr: process.platform === 'linux' ? 'invalid_config\n' : 'config_platform_unsupported\n'
        })
      }
      assert.deepEqual(await capture(['config', 'template', 'runtime', 'SYNTHETIC_SECRET_DO_NOT_PRINT']), {
        code: 2,
        stdout: '',
        stderr: 'invalid_arguments\n'
      })
      assert.deepEqual(readdirSync(root).sort(), ['role.json', 'runtime.json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
