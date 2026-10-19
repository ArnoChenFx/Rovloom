// 管理真实SDK测试的取消与子进程清理；测试超时后仍收敛pending拒绝，避免污染后续测试文件。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'

type TestLifetime = { after(cleanup: () => Promise<void>): void }
type Outcome = { ok: true } | { ok: false; error: unknown }

// 只供隔离SDK测试使用，关闭时停止前端等待，不将取消解释为native停止或回滚。
export function sdkTestSession(lifetime: TestLifetime, server: StdioServerParameters) {
  const client = new Client({ name: 'rovloom-isolated-sdk-session', version: '1.0.0' })
  const transport = new StdioClientTransport(server)
  return managedSdkTestSession(lifetime, client, transport)
}

// 沿用测试自定义的真实SDK子类，统一其取消、初始化失败和关闭过程；不改变协议实现。
export function managedSdkTestSession<C extends Client, T extends StdioClientTransport>(
  lifetime: TestLifetime,
  client: C,
  transport: T
) {
  const controller = new AbortController()
  let finishing = false
  let completion: Promise<Outcome> | undefined
  let closing: Promise<void> | undefined
  let transportClosing: Promise<void> | undefined
  const closeTransport = transport.close.bind(transport)
  // Client.connect初始化失败会主动void close；必须在transport层共享首次真实关闭，不能等到finally才登记。
  transport.close = /* SDK原close会先清空_process再等待退出，后续close仍须等待该同一个过程。 */ () =>
    (transportClosing ??= Promise.resolve().then(
      /* 先登记Promise再开始关闭，同步重入也共用同一过程。 */ () => closeTransport()
    ))
  // SDK close可能经历EOF/TERM/KILL；并发清理共享同一关闭过程，不重复操作子进程。
  const close = /* SDK可能已清空transport引用，仍须显式等待其原始关闭过程完成。 */ () =>
    (closing ??= Promise.resolve().then(
      /* 不从异常文本生成日志，并排空SDK正在运行的真实关闭。 */ async () => {
        await client.close()
        await transportClosing
      }
    ))
  lifetime.after(
    /* Bun超时不会中止TestContext.signal，显式先标记结束再取消，接住晚到拒绝并等待清理。 */ async () => {
      finishing = true
      controller.abort()
      try {
        await close()
      } finally {
        await completion
      }
    }
  )
  return {
    client,
    transport,
    close,
    signal: controller.signal,
    run: /* 立即把整个工作流的成功和失败都收敛为已处理结果，结束hook之后不再抛出晚到错误。 */ async (
      check: (client: C, transport: T, signal: AbortSignal) => Promise<void>
    ): Promise<void> => {
      if (completion || finishing) {
        throw new Error('sdk_test_session_unavailable')
      }
      completion = /* 把SDK和断言放入同一受管工作流，清理失败也进入下方已观察结果。 */ (async () => {
        try {
          await client.connect(transport, { timeout: 5000, signal: controller.signal })
          await check(client, transport, controller.signal)
        } finally {
          await close()
        }
      })().then(
        /* 成功同样转为有限结果，避免由清理路径重复执行工作流。 */ (): Outcome => ({ ok: true }),
        /* 保留原断言错误供正常用例失败；结束hook之后只排空，不形成未处理拒绝。 */ (error: unknown): Outcome => ({
          ok: false,
          error
        })
      )
      const outcome = await completion
      if (!finishing && !outcome.ok) {
        throw outcome.error
      }
    }
  }
}
