/** 用真实双库、认证 socket 和原 Wire 验证结果观察合并；只操作自有 IPC fixture 与合成身份。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Adapter } from '../../src/transport/index.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { clockWrites } from '../storage/clock-write-helpers.js'
import { runtimeFixture } from './helpers.js'

test(
  'runtime 结果只执行前后两次正文门禁，并保留末次来源、身份、句柄及凭据失效',
  { timeout: 30_000 },
  /** 计数器仅包装本 fixture；不把入口快照或先前通过的门禁作为最终交付依据。 */
  async () => {
    const f = await runtimeFixture()
    try {
      await f.ready()
      const admitted = await f.gateway.runAuthenticated(
        f.caller,
        /** 新意图只派发一次，仍使用真实原生 fixture 和完整响应事务。 */ () =>
          f.gateway.admit({
            target: f.target,
            native_request: { method: 'task.add', params: { title: 'isolated_result_observation' } },
            options: { binding_revision: 1, contract_ref: f.reference, deadline: f.state.store.clock() + 25_000 }
          })
      )
      await f.responded(admitted.call.call_id)
      const opened = await f.gateway.runAuthenticated(
        f.caller,
        /** 统计同次保留的真实提交；原 Wire 仍独立核对读取与保留权限。 */ () =>
          clockWrites(
            f.state.store,
            /** 实际申请原句柄，不用计数器替代任何校验。 */ () => f.gateway.results.open(admitted.call.call_id)
          )
      )
      assert(opened.updates <= 1, String(opened.updates))
      const meta = opened.result
      const identity = f.state.store
      const assertConnection = identity.assertConnection.bind(identity)
      let identityReads = 0
      identity.assertConnection = /** 每次均执行原 Store 连接 fence 校验，只记录实际次数。 */ (...args) => {
        identityReads++
        return assertConnection(...args)
      }
      const service = new RuntimeGatewayService(f.mcp)
      try {
        for (let index = 0; index < 2; index++) {
          identityReads = 0
          const reply = await service.execute(
            'runtime_call_get',
            { call_id: admitted.call.call_id, wait_ms: 0 },
            { caller: f.caller, wait_signal: new AbortController().signal }
          )
          assert.equal(reply.data.content_delivery, 'result_handle')
          assert.deepEqual(reply.data.result, {
            result_id: meta.result_id,
            bytes: meta.bytes,
            sha256: meta.hash,
            expires_at: meta.expires
          })
          // 每次服务查询仍真实观察设备 fence；已有句柄不再重复整轮保留检查。
          assert(identityReads > 0 && identityReads <= 45, String(identityReads))
        }
      } finally {
        service.close()
      }
      const resolve = f.gateway.transport.resolveOriginalRead
      const wires = new Map<Adapter, Adapter>()
      let lookups = 0
      let checks = 0
      let afterLookup: (() => void) | undefined
      let afterWire: (() => void) | undefined
      f.gateway.transport.resolveOriginalRead = /** 包装实际解析结果，故障发生在本次当前引用取得之后。 */ (
        callId,
        checkWire
      ) => {
        const original = resolve(callId, checkWire)
        if (!original) {
          return original
        }
        let wire = wires.get(original.wire)
        if (!wire) {
          wire = new Proxy({} as Adapter, {
            /** 保留原 Wire 接收者，包装不构造许可或替代原生检查。 */
            get(_target, key) {
              const value = Reflect.get(original.wire, key, original.wire)
              if (key === 'checkResult') {
                return /** 原门禁通过后再执行确定性故障，覆盖末次交付窗口。 */ (...args: unknown[]) => {
                  const result = Reflect.apply(value, original.wire, args)
                  if (++checks === 2) {
                    afterWire?.()
                  }
                  return result
                }
              }
              return typeof value === 'function' ? value.bind(original.wire) : value
            }
          })
          wires.set(original.wire, wire)
        }
        if (++lookups === 2) {
          afterLookup?.()
        }
        return { binding: original.binding, wire }
      }
      /** 每轮使用同一真实结果，不跨轮沿用权限、时间或数据库页。 */
      const read = () => {
        lookups = 0
        checks = 0
        identityReads = 0
        return f.gateway.runAuthenticated(
          f.caller,
          /** SQL 计数范围只有本轮同步读取；不包含异步握手或定时维护。 */ () =>
            clockWrites(
              f.state.store,
              /** 返回真实正文页及其原绝对期限。 */ () => f.gateway.results.read(meta.result_id, 0, 32)
            )
        )
      }
      for (let index = 0; index < 2; index++) {
        const measured = await read()
        assert.equal(checks, 2)
        assert(identityReads <= 40, String(identityReads))
        assert.equal(measured.updates, 0)
        assert.equal(measured.result.expires, meta.expires)
        assert.equal(Buffer.from(measured.result.data, 'base64').length, 32)
      }
      afterLookup = /** 最后一次引用解析后撤销来源，末次原 Wire 必须读取当前事实。 */ () => {
        f.native.state.trusted = false
      }
      await assert.rejects(read())
      f.native.state.trusted = true
      afterLookup = undefined
      afterWire = /** 最后一道原 Wire 之后撤销 caller，元数据引用不得成为交付许可。 */ () => f.authorize(false)
      await assert.rejects(read(), /unauthenticated/)
      f.authorize(true)
      afterWire = undefined
      const inspect = new DatabaseSync((f.state.store as unknown as { path: string }).path)
      try {
        afterWire = /** 第二连接删除实际句柄；不能因整轮持有旧 SQLite 快照而继续交付。 */ () => {
          inspect.prepare('DELETE FROM results WHERE result_id=?').run(meta.result_id)
        }
        await assert.rejects(read(), /result_not_found/)
      } finally {
        inspect.close()
      }
      afterWire = undefined
      const fresh = await f.gateway.runAuthenticated(
        f.caller,
        /** 明确发起新的句柄申请，以继续检查当前设备凭据撤销。 */ () => f.gateway.results.open(admitted.call.call_id)
      )
      lookups = 0
      afterLookup = /** 最后一次解析后真实提交凭据撤销及 Store fence 失效。 */ () =>
        f.state.store.revoke(f.target.machine_id)
      await assert.rejects(
        f.gateway.runAuthenticated(
          f.caller,
          /** 当前 caller 尚有效也不能借用已撤销设备的原结果。 */ () => f.gateway.results.read(fresh.result_id)
        )
      )
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.claims(), 1)
    } finally {
      await f.close()
    }
  }
)
