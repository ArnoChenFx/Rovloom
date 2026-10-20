/** 按真实角色验收发行：四项POSIX Gateway，同一Linux x64产品另须通过原生双角色往返。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { smokeGatewayProduct } from './gateway-smoke.mjs'
import { smokeDualRoleProduct } from './dual-role-smoke.mjs'

/** 每项目标必须运行实际Gateway；Linux x64不能跳过原生Owner，未支持角色明确标记。 */
export async function smokeProduct(binary, version, options = {}) {
  assert(['linux', 'darwin'].includes(process.platform), 'product_gateway_storage_platform_unsupported')
  assert(['x64', 'arm64'].includes(process.arch), 'product_gateway_arch_unsupported')
  binary = resolve(binary)
  assert(lstatSync(binary).isFile(), 'product_binary_required')
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
  const gateway = await smokeGatewayProduct(binary, version)
  assert.equal(gateway.product_sha256, digest, 'product_gateway_binary_mismatch')
  assert.deepEqual(gateway.schemaFactories, ['luvus', 'herdr'])
  // Gateway切片的pending不能变成角色支持声明；只有Linux x64必须且能够运行原生Owner。
  const { connector: _partialConnector, ...gatewayAcceptance } = gateway
  const nativeOwner = process.platform === 'linux' && process.arch === 'x64'
  let dualRole
  if (nativeOwner) {
    dualRole = await smokeDualRoleProduct(binary, options)
    assert.equal(dualRole.product_sha256, digest, 'product_binary_changed_between_acceptances')
    assert.equal(dualRole.gateway, 'passed')
    assert.equal(dualRole.connector, 'passed')
  }
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), digest)
  return {
    scope: 'product',
    platform: `${process.platform}-${process.arch}`,
    version,
    product_sha256: digest,
    gateway: gatewayAcceptance,
    ...(dualRole ? { dualRole } : {}),
    connector: nativeOwner ? 'passed' : 'unsupported',
    nativeOwner: nativeOwner ? 'passed' : 'unsupported'
  }
}

if (import.meta.main) {
  const [binary, version] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, 'Usage: bun scripts/release/product-smoke.mjs /built/product-binary version')
  console.log(JSON.stringify(await smokeProduct(binary, version)))
}
