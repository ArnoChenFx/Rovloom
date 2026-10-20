/** 完整发行验收：同一真实单文件的管理面、双schema工厂及Gateway→Connector→原生Herdr。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { smokeGatewayProduct } from './gateway-smoke.mjs'
import { smokeDualRoleProduct } from './dual-role-smoke.mjs'

/** 只接纳实际支持原生Owner的平台；其它目标不能以编译或局部验收换取发行收据。 */
export async function smokeProduct(binary, version, options = {}) {
  assert.equal(process.platform, 'linux', 'product_native_owner_platform_unsupported')
  assert.equal(process.arch, 'x64', 'product_native_owner_arch_unsupported')
  binary = resolve(binary)
  assert(lstatSync(binary).isFile(), 'product_binary_required')
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
  const gateway = await smokeGatewayProduct(binary, version)
  assert.equal(gateway.product_sha256, digest, 'product_gateway_binary_mismatch')
  const dualRole = await smokeDualRoleProduct(binary, options)
  assert.equal(dualRole.product_sha256, digest, 'product_binary_changed_between_acceptances')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), digest)
  assert.equal(dualRole.gateway, 'passed')
  assert.equal(dualRole.connector, 'passed')
  assert.deepEqual(gateway.schemaFactories, ['luvus', 'herdr'])
  // Gateway切片的pending字段只表达该切片范围；完整结果必须由真实Connector往返决定。
  const { connector: _partialConnector, ...gatewayAcceptance } = gateway
  return {
    scope: 'product',
    platform: `${process.platform}-${process.arch}`,
    version,
    product_sha256: digest,
    gateway: gatewayAcceptance,
    dualRole,
    connector: 'passed'
  }
}

if (import.meta.main) {
  const [binary, version] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, 'Usage: bun scripts/release/product-smoke.mjs /built/product-binary version')
  console.log(JSON.stringify(await smokeProduct(binary, version)))
}
