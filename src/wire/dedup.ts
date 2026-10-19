// 提供认证连接内固定容量、固定保留期的消息 ID 去重窗口。
import type { AuthenticatedEnvelope, CodecContext } from './types.js'
import { decodeWireObject } from './codec.js'
import { boundedJson, hash, LIMITS, uint, fail } from './validation.js'

// 连接级内存窗与持久化 call/key 墓碑独立；满窗拒绝准入，不淘汰承诺期内的 ID。
export class MessageWindow {
  readonly #entries = new Map<string, { hash: string; expires: number }>()
  #lastNow = -1

  // 校验去重容量和固定保留期，拒绝超过协议上限的容量。
  constructor(
    readonly capacity: number = LIMITS.dedup_entries,
    readonly ttl_ms: number = 60_000
  ) {
    uint(capacity, true)
    uint(ttl_ms, true)
    if (capacity > LIMITS.dedup_entries) {
      fail('dedup_limit')
    }
  }

  // 清理过期项后登记消息摘要；重复返回 duplicate，冲突或满窗则拒绝。
  observe(frame: AuthenticatedEnvelope, context: CodecContext, now: number): 'new' | 'duplicate' {
    uint(now)
    if (now < this.#lastNow || !Number.isSafeInteger(now + this.ttl_ms)) {
      fail('clock_untrusted')
    }
    this.#lastNow = now

    const raw = boundedJson(frame, LIMITS.object_bytes)
    const valid = decodeWireObject(Buffer.from(raw), context)
    const key = [
      valid.machine_id,
      valid.recovery_generation,
      valid.connection_epoch,
      context.direction,
      valid.message_id
    ].join(':')
    for (const [entryKey, entry] of this.#entries) {
      if (entry.expires <= now) {
        this.#entries.delete(entryKey)
      }
    }

    const digest = hash(raw)
    const old = this.#entries.get(key)
    if (old) {
      if (old.hash !== digest) {
        fail('message_id_conflict')
      }
      return 'duplicate'
    }

    if (this.#entries.size >= this.capacity) {
      fail('dedup_window_full')
    }
    this.#entries.set(key, { hash: digest, expires: now + this.ttl_ms })
    return 'new'
  }

  // 返回当前窗口中的登记数，包含尚未由 observe 清理的过期项。
  get size(): number {
    return this.#entries.size
  }
}
