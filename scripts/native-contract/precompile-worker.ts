// 构建期固定 Worker 始终完整编译，不导入运行时资产查询，也不生成宿主 opaque 句柄。
import { compileArtifact } from '../../src/native-contract/compiler-core.js'
import type { CompileJob } from '../../src/native-contract/compiler-protocol.js'

const channel = globalThis as unknown as {
  onmessage: (event: { data: CompileJob }) => void
  postMessage(value: unknown): void
}
// 编译异常可能带源码，构建只报告固定失败状态。
function discardLog(): void {}
console.log = console.warn = console.error = discardLog
channel.onmessage = /* 输入只来自仓库生成器，明确不传预编译查询端口。 */ ({ data }) => {
  channel.postMessage(compileArtifact(data.bytes, data.options))
}
