// 验证锁定 MCP SDK 与独立 Bun 子进程的真实 stdio 协商和协议版本边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeSdk } from './sdk-compatibility.mjs'

test(
  '所锁 SDK 客户端与独立 stdio 子进程协商已核实的 2025-11-25',
  { timeout: 10000 },
  /* 执行真实 SDK 往返，核对锁定版本和已实证的协议协商结果。 */ async () => {
    const report = await probeSdk()
    assert.equal(report.negotiated, '2025-11-25')
    assert.equal(report.dependencies['@modelcontextprotocol/sdk'].version, '1.32.1')
    assert.equal(report.sdk_supported_constants.includes('2026-07-28'), false)
  }
)
