import type { AuthenticatedEnvelope, CodecContext } from './types.js'
import { decodeWireObject } from './codec.js'
import { boundedJson, hash, LIMITS, uint, fail } from './validation.js'

// 连接级内存窗与持久化 call/key 墓碑独立；满窗拒绝准入，不淘汰承诺期内的 ID。
export class MessageWindow {
  readonly #entries = new Map<string, { hash: string; expires: number }>()
  #lastNow = -1

  constructor(
    readonly capacity: number = LIMITS.dedup_entries,
    readonly ttl_ms: number = 60_000
  ) {
    uint(capacity, true)
    uint(ttl_ms, true)
    if (capacity > LIMITS.dedup_entries) fail('dedup_limit')
  }

  observe(frame: AuthenticatedEnvelope, context: CodecContext, now: number): 'new' | 'duplicate' {
    uint(now)
    if (now < this.#lastNow || !Number.isSafeInteger(now + this.ttl_ms)) fail('clock_untrusted')
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
      if (entry.expires <= now) this.#entries.delete(entryKey)
    }

    const digest = hash(raw)
    const old = this.#entries.get(key)
    if (old) {
      if (old.hash !== digest) fail('message_id_conflict')
      return 'duplicate'
    }

    if (this.#entries.size >= this.capacity) fail('dedup_window_full')
    this.#entries.set(key, { hash: digest, expires: now + this.ttl_ms })
    return 'new'
  }

  get size(): number {
    return this.#entries.size
  }
}
