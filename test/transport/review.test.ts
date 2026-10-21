// 回归独立审查确认的截止时间边界：宿主回调推进到 deadline 后不得实际执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, until } from './helpers.js'

test(
  'auth 注入或 accepted 编码推进到 deadline，均不能实际执行',
  { timeout: 15_000 },
  /** 用可控可信时间在两个宿主回调中到期，检查 execute 次数始终为零。 */
  async () => {
    for (const phase of ['nativeInput', 'accepted'] as const) {
      const f = fixture()
      let executed = 0
      let crossed = false
      try {
        const device = f.pair('mock_deadline_' + phase)
        const client = f.connector(
          /** 仅读取本次无生产效力 fixture 凭据。 */
          () => device.credential,
          {
            /** 在 auth 注入点推进到截止时间，模拟注入与编码所耗时间。 */
            nativeInput(input, binding) {
              if (phase === 'nativeInput') {
                crossed = true
                f.now = binding.registration.deadline
              }
              return input
            },
            /** 保留真实 adapter，仅在 accepted 编码后推进可信时间到截止边界。 */
            session(connection) {
              const current = f.session(connection)
              const encode = current.adapter.encode
              return {
                ...current,
                adapter: {
                  ...current.adapter,
                  /** accepted 的编码也可能消耗时间，真正 execute 前必须再次复验。 */
                  encode(frame, direction) {
                    const raw = encode(frame, direction)
                    if (phase === 'accepted' && frame.type === 'accepted') {
                      crossed = true
                      f.now = frame.payload.attempt.registration.deadline
                    }
                    return raw
                  }
                }
              }
            },
            /** 只计数 mock 执行；到期路径绝不应该进入这个宿主边界。 */
            async execute(raw) {
              executed++
              return { id: JSON.parse(raw).id, result: { id: 'mock' } }
            }
          }
        )
        await until(
          /** 必须先收到真实 welcome 并 ready。 */
          () => client.status().phase === 'ready'
        )
        const call = f.call(device.target)
        f.gateway.dispatch(call.call_id)
        await until(
          /** 等待到期拒绝导致真实连接关闭，不能以短暂未执行当作成功。 */
          () => crossed && f.gateway.status().connections === 0
        )
        assert.equal(executed, 0)
      } finally {
        f.stop()
      }
    }
  }
)
