// 只启动离线 schema 编译器供父死亡测试使用，不连接原生端点或继承配置。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SchemaProcess } from '../../src/native-contract/process-host.js'

const bytes = readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/schema-bundle.json', import.meta.url))
const payload = {
  bytes: bytes.toString('utf8'),
  options: {
    identity: {
      binary_sha256: 'a'.repeat(64),
      schema_sha256: createHash('sha256').update(bytes).digest('hex'),
      revision: 'synthetic-parent-death'
    }
  }
}
// 先准备合成输入，再启动有内核时限的进程，避免把首次 crypto 初始化延迟带入等待帧阶段。
const compiler = new SchemaProcess(process.argv[2]!)
compiler.request('compile', payload)
await Bun.write(Bun.stdout, String(compiler.processId()) + '\n')
await Bun.sleep(10000)
compiler.stop()
