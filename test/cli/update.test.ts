// 通过唯一CLI使用现行更新模块与合成官方响应fixture，不联网、下载执行或替换产品文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { runCli, type CliRuntime } from '../../src/cli/run.js'
import { UpdateError } from '../../src/update/contract.js'
import { fixture } from '../update/fixtures.js'

// 捕获真实CLI输出；所有网络请求只到明确fixture端口，不依赖公开发行是否存在。
async function capture(args: string[], runtime?: CliRuntime, signal = new AbortController().signal) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', /* 更新状态不能进入模板或协议stdout。 */ (chunk) => (out += chunk))
  stderr.on('data', /* 核对stderr只有固定代码及非秘密版本元数据。 */ (chunk) => (err += chunk))
  const code = await runCli(args, { stdin: new PassThrough(), stdout, stderr, signal }, runtime)
  return { code, stdout: out, stderr: err }
}

// 使用fixture注入受信平台/版本，生产默认值仍来自实际运行时与构建常量。
function host() {
  const f = fixture()
  return {
    f,
    runtime: {
      update: { ...f.network, currentVersion: '1.0.0', platform: 'linux', arch: 'x64', libc: 'glibc' as const }
    }
  }
}

test(
  'update帮助离线，非法URL/秘密参数不回显且不发出网络请求',
  /* 保持唯一入口的参数拒绝。 */ async () => {
    const { f, runtime } = host()
    const help = await capture(['update', '--help'], runtime)
    assert.equal(help.code, 0)
    assert.equal(help.stdout, '')
    assert.match(help.stderr, /update --check/)
    for (const args of [
      ['update', '--url', 'https://SYNTHETIC_SECRET.invalid'],
      ['update', '--force'],
      ['update', '--check', '--check']
    ]) {
      assert.deepEqual(await capture(args, runtime), { code: 2, stdout: '', stderr: 'update: invalid_arguments\n' })
    }
    assert.equal(f.requests.length, 0)
  }
)

test(
  'update实际请求收到CLI取消，不等待完整网络预算或继续后续检查',
  /* 合成fetch只观察既有AbortSignal，不执行网络或假装强退底层任务。 */ async () => {
    const h = host()
    const stop = new AbortController()
    let received!: () => void
    const requested = new Promise<void>(/* 等实际fetch收到共同signal后再取消。 */ (resolve) => (received = resolve))
    let calls = 0
    let aborted = false
    h.runtime.update.fetch = /* 合作的受信网络fixture保留真实请求取消语义。 */ async (_url, init) => {
      calls++
      return new Promise<Response>(
        /* 与实际fetch一样，收到abort才结束当前请求。 */ (_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            /* 不向公开stderr交付底层异常内容。 */ () => {
              aborted = true
              reject(new Error('SYNTHETIC_SECRET_DO_NOT_PRINT'))
            },
            { once: true }
          )
          received()
        }
      )
    }
    const pending = capture(['update', '--check'], h.runtime, stop.signal)
    await requested
    stop.abort()
    assert.deepEqual(await pending, { code: 3, stdout: '', stderr: 'update: network_failed\n' })
    assert.equal(calls, 1)
    assert.equal(aborted, true)
  }
)

test(
  'update检查复用官方元数据契约，无替换事务时真实返回5而不是升级成功',
  /* 不开放任意下载、shell或文件写入端口。 */ async () => {
    const check = host()
    assert.deepEqual(await capture(['update', '--check'], check.runtime), {
      code: 0,
      stdout: '',
      stderr: 'current=1.0.0 target=1.2.0 status=available\n'
    })
    assert.equal(check.f.requests.length, 3)
    const replacement = host()
    assert.deepEqual(await capture(['update'], replacement.runtime), {
      code: 5,
      stdout: '',
      stderr: 'current=1.0.0 target=1.2.0 status=available\nupdate: replacement_unavailable\n'
    })
    assert.equal(replacement.f.requests.length, 3)
  }
)

test(
  'update未知运行时代码不能泄露；当前预发行版本沿用规范比较',
  /* 类型违约和实际构建版本都不能造成假成功。 */ async () => {
    const h = host()
    h.runtime.update.fetch = /* 模拟损坏宿主的带秘密code，不能相信TS联合类型。 */ async () => {
      throw new UpdateError('SYNTHETIC_SECRET_DO_NOT_PRINT' as never)
    }
    const unknown = await capture(['update', '--check'], h.runtime)
    assert.equal(unknown.code, 1)
    assert.equal(unknown.stdout, '')
    assert.equal(unknown.stderr, 'runtime_failed\n')
    const development = host()
    development.runtime.update.currentVersion = '0.1.0-dev'
    assert.deepEqual(await capture(['update', '--check'], development.runtime), {
      code: 0,
      stdout: '',
      stderr: 'current=0.1.0-dev target=1.2.0 status=available\n'
    })
    assert.equal(development.f.requests.length, 3)
    const invalid = host()
    invalid.runtime.update.currentVersion = 'SYNTHETIC_SECRET_DO_NOT_PRINT'
    assert.deepEqual(await capture(['update', '--check'], invalid.runtime), {
      code: 2,
      stdout: '',
      stderr: 'update: invalid_current_version\n'
    })
    assert.equal(invalid.f.requests.length, 0)
  }
)
