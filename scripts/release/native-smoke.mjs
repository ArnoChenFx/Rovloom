/** 隔离验收官方资产内嵌与未知 schema 的完整 Worker、standalone 和 helper 路径。 */
import assert from 'node:assert/strict'
import { buildStandalone } from './build.mjs'
import { smokeStandalone } from './smoke.mjs'

const output = await buildStandalone({
  entrypoint: 'test/release/native-probe.mjs',
  workers: [
    'src/native-contract/compiler-worker.ts',
    'src/connector/herdr/compiler-herdr-worker.ts',
    'test/release/precompiled-worker.ts'
  ],
  probe: 'native-contract'
})
const [result] = await smokeStandalone(output.binary, [{ args: [], code: 0, stderr: /^$/u }])
assert.deepEqual(JSON.parse(result.stdout), {
  scope: 'native-contract-probe',
  documents: 29,
  errorDataPreserved: true,
  precompiledEmbedded: true,
  unknownSchemaWorker: { documents: 9, malformedRejected: true, unknownKeywordRejected: true, helpersValidated: true },
  herdr: { version: '0.9.5', originalRoots: true, compiledBrand: true }
})
console.log(JSON.stringify({ scope: 'native-contract-probe', isolatedRuntime: 'pass', sha256: output.manifest.sha256 }))
