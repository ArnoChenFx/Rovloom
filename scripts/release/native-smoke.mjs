/** 为显式接入的纯 Bun schema Worker 编译隔离探针，验证真实 Ajv standalone/helper 路径。 */
import assert from 'node:assert/strict'
import { buildStandalone } from './build.mjs'
import { smokeStandalone } from './smoke.mjs'

const output = await buildStandalone({
  entrypoint: 'test/release/native-probe.mjs',
  workers: ['src/native-contract/compiler-worker.ts', 'src/connector/herdr/compiler-herdr-worker.ts'],
  probe: 'native-contract'
})
const [result] = smokeStandalone(output.binary, [{ args: [], code: 0, stderr: /^$/u }])
assert.deepEqual(JSON.parse(result.stdout), {
  scope: 'native-contract-probe',
  documents: 29,
  errorDataPreserved: true,
  herdr: { version: '0.9.5', originalRoots: true, compiledBrand: true }
})
console.log(JSON.stringify({ scope: 'native-contract-probe', isolatedRuntime: 'pass', sha256: output.manifest.sha256 }))
