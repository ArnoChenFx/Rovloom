/** 用真实 RPC adapter、完整 Wire 校验和自有 IPC 验证原 deadline 后的索引回收，不调用外部 native。 */
import assert from 'node:assert/strict'
import { phaseTiming } from '../../support/phase-timing.js'
import { test } from 'node:test'
import { LuvusRpcAdapter } from '../../../src/connector/luvus/adapter.js'
import { fixture } from './helpers.js'

test(
  'one RPC adapter continues beyond 128 cumulative intents and still protects its original active quota',
  // 基线单独运行 29,969 ms；258 次明确的新意图共用外层预算，不改变每次 native deadline。
  { timeout: 60_000 },
  /** 正文/claim 都使用本测试的合成来源；不能以新 adapter 或新 epoch 掩盖索引累计。 */ async () => {
    const f = await phaseTiming('luvus.rpc.fixture', () => fixture())
    const claims = new Set<string>()
    const adapter = new LuvusRpcAdapter(f.config, {
      ...f.host,
      /** 保留本测试每个意图唯一 claim，允许多个显式新意图而不复用原请求键。 */ async claimDispatch(binding) {
        const key = binding.call_id + ':' + binding.attempt_id
        assert(!claims.has(key))
        claims.add(key)
      }
    })
    f.respond(
      /** 每个自有连接只按其原 ID 回合成响应。 */ (socket, raw) => {
        const input = JSON.parse(raw)
        socket.end(JSON.stringify({ ...f.response, id: input.id }) + '\n')
      }
    )
    /** 只更新受信 fixture 的完整登记锚点，消息参数不能建立生产身份。 */
    function intent(index: number, deadline: number): string {
      f.binding.call_id = 'lifetime_call_' + index
      f.binding.native_request_id = 'lifetime_native_' + index
      f.binding.registration.deadline = deadline
      const { machine_id: _machine, recovery_generation: _generation, connection_epoch: _epoch, ...attempt } = f.binding
      f.envelope.message_id = 'lifetime_message_' + index
      f.envelope.payload.attempt = attempt
      return f.input()
    }
    try {
      let original = ''
      let originalBinding = structuredClone(f.binding)
      await phaseTiming('luvus.rpc.lifetime.expired', async () => {
        for (let index = 0; index < 129; index++) {
          const raw = intent(index, f.state.now + 10_000)
          if (index === 0) {
            original = raw
            originalBinding = structuredClone(f.binding)
          }
          await adapter.dispatch(raw)
          f.state.now += 10_000
        }
      })
      assert.equal(claims.size, 129)
      assert.equal(f.state.responses, 129)
      const activeDeadline = f.state.now + 10_000
      await phaseTiming('luvus.rpc.lifetime.active', async () => {
        for (let index = 129; index < 257; index++) {
          await adapter.dispatch(intent(index, activeDeadline))
        }
      })
      const duplicate = f.input()
      await assert.rejects(adapter.dispatch(duplicate), /attempt_already_observed/)
      await assert.rejects(adapter.dispatch(intent(257, activeDeadline)), /local_attempt_limit/)
      assert.equal(claims.size, 257)
      f.state.now = activeDeadline
      await adapter.dispatch(intent(258, activeDeadline + 10_000))
      assert.equal(claims.size, 258)
      Object.assign(f.binding, originalBinding)
      await assert.rejects(adapter.dispatch(original), /deadline|expired|native_timeout/)
      assert.equal(claims.size, 258)
    } finally {
      adapter.close()
      await f.close()
    }
  }
)

test(
  'RPC history refuses a clock rollback without issuing another native claim',
  /** 只回退同一 adapter 的受控时钟，原历史与当前来源都保持不变。 */ async () => {
    const f = await fixture()
    try {
      await f.adapter.dispatch(f.input())
      f.state.now--
      await assert.rejects(f.adapter.dispatch(f.input()), /clock_untrusted|adapter_closed/)
      assert.equal(f.state.claims, 1)
      assert.equal(f.state.responses, 1)
    } finally {
      await f.close()
    }
  }
)
