// 验证纯管理写客户端/状态机能以browser target构建，不把Node认证crypto或秘密来源带入浏览器。
import { test } from 'node:test'
import assert from 'node:assert/strict'

test(
  '管理写客户端与有限状态机可独立构建为浏览器模块',
  /** 只生成内存产物，不启动页面、监听器或身份流程。 */ async () => {
    const result = await Bun.build({
      entrypoints: ['src/webui/write-client.ts', 'src/webui/write-flow.ts'],
      target: 'browser',
      format: 'esm',
      splitting: true,
      write: false
    })
    assert.equal(result.success, true)
    assert(result.outputs.length >= 2)
    for (const output of result.outputs) {
      const text = await output.text()
      assert(!text.includes('node:crypto'))
      assert(!text.includes('resolveCookie'))
    }
  }
)
