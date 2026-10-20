/** 使用真实产品编译和受保护离线种子验收HTTP；没有模型、真实配对或外部凭据。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStandalone } from '../../scripts/release/build.mjs'
import { product } from '../../scripts/release/product.mjs'
import { smokeGatewayProduct } from '../../scripts/release/gateway-smoke.mjs'
import { PRODUCT_VERSION } from '../../src/mcp/version.ts'

test(
  'standalone product runs real Gateway, authenticated MCP, management writes and both schema factories',
  { timeout: 60_000, skip: !['linux', 'darwin', 'win32'].includes(process.platform) },
  /** 只复制本次二进制，空PATH/HOME不能提供Bun、Node、源码或WebUI补包。 */ async () => {
    const output = await buildStandalone(product)
    const accepted = await smokeGatewayProduct(output.binary, PRODUCT_VERSION)
    assert.equal(accepted.scope, 'product-gateway')
    assert.equal(accepted.connector, 'pending')
    assert.deepEqual(accepted.schemaFactories, ['luvus', 'herdr'])
    const incomplete = await buildStandalone({ ...product, workers: [] })
    await assert.rejects(
      /** 漏掉Worker内嵌接线不能降级成CLI成功。 */ () => smokeGatewayProduct(incomplete.binary, PRODUCT_VERSION),
      /product_gateway_not_listening/u
    )
  }
)
