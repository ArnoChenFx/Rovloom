// 只用自有合成 Bun child 检查 proxy 退出状态，不启动 native、访问模型或建立产品身份。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { readStableProxyReply } from '../../scripts/runtime/luvus-stable-selection.mjs'

/** 固定合成 JSON 和明确退出码，验证完整 stdout 不能洗掉失败退出语义。 */
function output(exitCode, error) {
  const frame = { id: 'isolated_proxy', ...(error ? { error: { code: 'not_found' } } : { result: {} }) }
  const child = spawnSync(
    process.execPath,
    [
      '--no-env-file',
      '-e',
      'process.stdout.write(process.argv[1]); process.exit(Number(process.argv[2]))',
      JSON.stringify(frame),
      String(exitCode)
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 4096 }
  )
  assert.equal(child.signal, null)
  assert.equal(child.status, exitCode)
  return child
}

test(
  'native acceptance keeps successful exits and the official error exit distinguishable',
  /** 原生错误帧保持原样，不改成成功。 */ () => {
    const success = output(0, false)
    assert.deepEqual(readStableProxyReply(success.stdout, 'isolated_proxy', success.status).result, {})
    const nativeError = output(1, true)
    assert.equal(readStableProxyReply(nativeError.stdout, 'isolated_proxy', nativeError.status).error.code, 'not_found')
  }
)

test(
  'complete proxy JSON cannot disguise other failure exits or exit one with a success body',
  /** 真实 child 即使输出完整 JSON，失败仍须失败。 */ () => {
    for (const [code, error] of [
      [2, false],
      [2, true],
      [1, false]
    ]) {
      const child = output(code, error)
      assert.throws(
        /** 每个失败退出都不能被正文覆盖。 */ () => readStableProxyReply(child.stdout, 'isolated_proxy', child.status),
        /stable_native_proxy_failed/
      )
    }
    assert.throws(
      /** 错 ID 不能借成功退出进入验收。 */ () =>
        readStableProxyReply(Buffer.from('{"id":"other","result":{}}'), 'isolated_proxy', 0)
    )
  }
)
