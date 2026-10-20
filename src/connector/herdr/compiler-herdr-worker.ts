/** 私有 Herdr Worker 只接纳固定官方 schema 与构建资产；不执行 RPC 或运行时 Ajv 编译。 */
import { precompiledHerdrArtifact } from './precompiled.js'
import { HERDR_COMPILER_VERSION } from './compiler-protocol.js'
import type { HerdrCompileJob } from './compiler-protocol.js'

const channel = globalThis as unknown as {
  onmessage: (event: { data: unknown }) => void
  postMessage(message: unknown): void
}

/** 屏蔽可能包含安装 schema 或生成代码的编译诊断。 */
function discardLog(): void {}
console.log = console.warn = console.error = discardLog

// 私有通道只接收可关联的精确任务，未知协议不尝试推断或降级。
channel.onmessage = /** 严格校验字段和版本后编译本条任务，返回纯数据结果。 */ (event) => {
  const job = event.data as HerdrCompileJob
  if (!job || typeof job !== 'object' || typeof job.job_id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.job_id)) {
    return
  }
  if (
    Array.isArray(job) ||
    Object.keys(job).length !== 3 ||
    !['version', 'job_id', 'bytes'].every(/** 禁止缺字段或额外选项进入编译器。 */ (key) => Object.hasOwn(job, key)) ||
    job.version !== HERDR_COMPILER_VERSION
  ) {
    channel.postMessage({
      version: HERDR_COMPILER_VERSION,
      job_id: job.job_id,
      result: { ok: false, reason: 'compiler_protocol_invalid' }
    })
    return
  }
  channel.postMessage({
    version: HERDR_COMPILER_VERSION,
    job_id: job.job_id,
    result: precompiledHerdrArtifact(job.bytes)
  })
}
