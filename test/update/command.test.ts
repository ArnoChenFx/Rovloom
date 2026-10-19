// 验证唯一 CLI 的窄接缝、只读检查、明确无更新与缺替换宿主非零失败，不创建第二入口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleUpdateCommand, type UpdateCommandHost } from '../../src/update/command.js'
import { fixture } from './fixtures.js'

// 注入现有 CLI 应提供的版本、平台与诊断通道，不加载真实配置或安装路径。
function host(currentVersion = '1.0.0') {
  const f = fixture()
  const output: string[] = []
  const context: UpdateCommandHost = {
    ...f.network,
    currentVersion,
    platform: 'linux',
    arch: 'x64',
    // 测试只捕获固定诊断，不写 MCP stdout。
    write: (message) => {
      output.push(message)
    }
  }
  return { f, output, context }
}

test(
  'non-update arguments return to the original parser without fetch',
  /* 不抢占已有角色和 service 命令。 */ async () => {
    const h = host()
    for (const args of [[], ['--help'], ['gateway'], ['service', 'stop', 'connector'], ['config', 'check']]) {
      assert.equal(await handleUpdateCommand(args, h.context), undefined)
    }
    assert.equal(h.f.requests.length, 0)
    assert.equal(h.output.length, 0)
  }
)

test(
  'check shows current/target and never downloads binary or invokes filesystem/service',
  /* host 根本没有写文件或服务端口。 */ async () => {
    const h = host()
    assert.equal(await handleUpdateCommand(['update', '--check'], h.context), 0)
    assert.equal(h.output.join(''), 'current=1.0.0 target=1.2.0 status=available\n')
    assert.equal(h.f.requests.length, 2)
  }
)

test(
  'update returns nonzero when safe replacement transaction is unavailable',
  /* 下载成功也不能伪造替换成功。 */ async () => {
    const h = host()
    assert.equal(await handleUpdateCommand(['update'], h.context), 5)
    assert(h.output.join('').includes('replacement_unavailable'))
    assert.equal(h.f.requests.length, 2)
  }
)

test(
  'no-update statuses succeed without binary fetch',
  /* 同版和新于发行版分别显示。 */ async () => {
    for (const version of ['1.2.0', '2.0.0']) {
      const h = host(version)
      assert.equal(await handleUpdateCommand(['update'], h.context), 0)
      assert.equal(h.f.requests.length, 2)
      assert(!h.output.join('').includes('replacement_unavailable'))
    }
  }
)

test(
  'help is offline and URL/config/script/unknown parameters fail with code 2',
  /* 无任意路径或脚本通道。 */ async () => {
    const h = host()
    assert.equal(await handleUpdateCommand(['update', '--help'], h.context), 0)
    for (const args of [
      ['update', '--url', 'https://evil.invalid'],
      ['update', '--config', '/tmp/config'],
      ['update', 'sh'],
      ['update', '--check', '--check'],
      ['update', '--force']
    ]) {
      assert.equal(await handleUpdateCommand(args, h.context), 2)
    }
    assert.equal(h.f.requests.length, 0)
  }
)

test(
  'unsupported platform and network failure have distinct nonzero exits without private details',
  /* 输出只包含固定公共错误。 */ async () => {
    const h = host()
    assert.equal(await handleUpdateCommand(['update', '--check'], { ...h.context, arch: 'ia32' }), 2)
    assert.equal(
      await handleUpdateCommand(['update', '--check'], {
        ...h.context,
        fetch: /* 注入私密传输异常。 */ async () => {
          throw new Error('private token')
        }
      }),
      3
    )
    assert(!h.output.join('').includes('private'))
  }
)
