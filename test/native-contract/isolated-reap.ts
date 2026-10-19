// 在独立测试宿主内接管本次孤儿回收，确认反复超时不会遗留校验进程或僵尸。
import assert from 'node:assert/strict'
import { dlopen, ptr, read } from 'bun:ffi'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SchemaProcess } from '../../src/native-contract/process-host.js'

const library = dlopen('libc.so.6', {
  prctl: { args: ['i32', 'u64', 'u64', 'u64', 'u64'], returns: 'i32' },
  waitpid: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
  __errno_location: { args: [], returns: 'ptr' }
})
// 只改变本测试进程的子进程回收职责，退出即消失，不修改系统/宿主策略。
assert.equal(library.symbols.prctl(36, 1, 0, 0, 0), 0)
const bundle = JSON.parse(
  readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/schema-bundle.json', import.meta.url), 'utf8')
)
const uri = 'https://luvus.dev/protocol/uhp/v1/schema/reap-test.schema.json'
bundle.documents[uri] = {
  $id: uri,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'string',
  pattern: '(a+)+$'
}
const bytes = JSON.stringify(bundle)
const identity = {
  binary_sha256: 'a'.repeat(64),
  schema_sha256: createHash('sha256').update(bytes).digest('hex'),
  revision: 'synthetic-reap'
}
for (let count = 0; count < 2; count++) {
  const compiler = new SchemaProcess(process.argv[2]!)
  try {
    const metadata = compiler.request('compile', { bytes, options: { identity } }) as { epoch: string }
    const start = performance.now()
    assert.throws(
      /* 真实正则超时必须使整个上下文失效。 */ () =>
        compiler.request('validate', { identity, epoch: metadata.epoch, schema: uri, value: 'a'.repeat(20000) + '!' })
    )
    assert(performance.now() - start >= 1500)
  } finally {
    compiler.stop()
  }
  const status = Buffer.alloc(4)
  assert.equal(library.symbols.waitpid(-1, ptr(status), 1), -1, 'no live or zombie descendants may remain')
  assert.equal(read.i32(library.symbols.__errno_location()!), 10)
}
console.log('reaped')
