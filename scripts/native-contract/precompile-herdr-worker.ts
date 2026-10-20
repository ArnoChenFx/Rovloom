/** 构建期 Herdr Worker 始终从完整正式 schema 编译，不导入或查询待检查资产。 */
import { compileHerdrArtifact } from '../../src/connector/herdr/compiler-core.js'

const channel = globalThis as unknown as {
  onmessage: (event: { data: Uint8Array }) => void
  postMessage(value: unknown): void
}

/** 编译异常可能包含 schema，构建只接纳固定结果，不输出底层源码。 */
function discardLog(): void {}
console.log = console.warn = console.error = discardLog
channel.onmessage = /** 受维护构建进程只交付本仓库已审核原字节。 */ ({ data }) => {
  channel.postMessage(compileHerdrArtifact(data))
}
