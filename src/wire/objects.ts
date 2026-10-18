import type { AuthenticatedEnvelope, CodecContext, JsonObject } from './types.js';
import { decodeWireFrame, decodeWireObject, encodeWireFrame } from './codec.js';
import { boundedJson, hash, LIMITS, parseJson, object, id, uint, fail } from './validation.js';

type Chunk = Extract<AuthenticatedEnvelope, { type: 'object_chunk' }>;
type Completed =
  | { kind: 'envelope'; envelope: AuthenticatedEnvelope }
  | { kind: 'schema_bundle'; bundle: JsonObject };
type Transfer = { descriptor: string; expires: number; parts: Buffer[]; total: number };
export function fragmentObject(
  value: unknown,
  kind: 'envelope' | 'schema_bundle',
  objectId: string,
  context: CodecContext,
): Chunk[] {
  if (context.phase !== 'authenticated') fail('authentication_required');
  id(objectId);
  const raw = boundedJson(
    value,
    kind === 'schema_bundle' ? LIMITS.schema_bundle_bytes : LIMITS.object_bytes,
  );
  if (kind === 'envelope') decodeWireObject(Buffer.from(raw), context);
  else object(parseJson(raw, LIMITS.schema_bundle_bytes));
  const data = Buffer.from(raw),
    count = Math.ceil(data.length / LIMITS.chunk_bytes),
    digest = hash(data);
  return Array.from({ length: count }, (_, index) => {
    const frame: Chunk = {
      protocol_major: context.connection.negotiated.major,
      protocol_minor: context.connection.negotiated.minor,
      type: 'object_chunk',
      message_id: `chunk_${hash(objectId)}_${index}`,
      machine_id: context.connection.machine_id,
      recovery_generation: context.connection.recovery_generation,
      connection_epoch: context.connection.connection_epoch,
      payload: {
        object_id: objectId,
        kind,
        total_bytes: data.length,
        sha256: digest,
        chunk_count: count,
        index,
        data: data
          .subarray(index * LIMITS.chunk_bytes, (index + 1) * LIMITS.chunk_bytes)
          .toString('base64'),
      },
    };
    encodeWireFrame(frame, context);
    return frame;
  });
}
// 只允许顺序分片；固定首片截止时间，不因重复/进度续期。实例限于一个认证连接/方向。
export class ObjectAssembler {
  readonly #active = new Map<string, Transfer>();
  readonly #closed = new Map<string, number>();
  #binding: string | undefined;
  #lastNow = -1;
  #bytes = 0;
  push(frame: Chunk, context: CodecContext, now: number): Completed | undefined {
    uint(now);
    if (now < this.#lastNow || !Number.isSafeInteger(now + LIMITS.transfer_timeout_ms))
      fail('clock_untrusted');
    this.#lastNow = now;
    const valid = decodeWireFrame(encodeWireFrame(frame, context), context);
    if (context.phase !== 'authenticated' || valid.type !== 'object_chunk')
      fail('authentication_required');
    const current = [
      valid.machine_id,
      valid.recovery_generation,
      valid.connection_epoch,
      context.direction,
    ].join(':');
    if (this.#binding !== undefined && current !== this.#binding)
      fail('object_connection_mismatch');
    this.#binding = current;
    for (const [key, transfer] of this.#active)
      if (now >= transfer.expires) this.#close(key, transfer, now);
    for (const [key, expires] of this.#closed) if (now >= expires) this.#closed.delete(key);
    const p = valid.payload,
      key = p.object_id;
    if (this.#closed.has(key)) fail('object_closed');
    const descriptor = boundedJson({
      kind: p.kind,
      total_bytes: p.total_bytes,
      sha256: p.sha256,
      chunk_count: p.chunk_count,
    });
    let transfer = this.#active.get(key);
    if (!transfer) {
      if (p.index !== 0) fail('chunk_out_of_order');
      if (
        this.#active.size >= LIMITS.transfers ||
        this.#closed.size + this.#active.size >= LIMITS.dedup_entries ||
        this.#bytes + p.total_bytes > LIMITS.buffered_bytes
      )
        fail('object_capacity');
      transfer = {
        descriptor,
        expires: now + LIMITS.transfer_timeout_ms,
        parts: [],
        total: p.total_bytes,
      };
      this.#active.set(key, transfer);
      this.#bytes += p.total_bytes;
    }
    if (transfer.descriptor !== descriptor) {
      this.#close(key, transfer, now);
      fail('object_conflict');
    }
    const chunk = Buffer.from(p.data, 'base64');
    if (p.index < transfer.parts.length) {
      if (!chunk.equals(transfer.parts[p.index]!)) {
        this.#close(key, transfer, now);
        fail('chunk_conflict');
      }
      return undefined;
    }
    if (p.index !== transfer.parts.length) fail('chunk_out_of_order');
    transfer.parts.push(chunk);
    if (transfer.parts.length !== p.chunk_count) return undefined;
    const data = Buffer.concat(transfer.parts);
    this.#close(key, transfer, now);
    if (data.length !== p.total_bytes || hash(data) !== p.sha256) fail('object_checksum');
    if (p.kind === 'envelope')
      return { kind: 'envelope', envelope: decodeWireObject(data, context) };
    // 只交付离线 bundle 对象；必须经原生模块完整编译才能作为可信契约使用。
    return { kind: 'schema_bundle', bundle: object(parseJson(data, LIMITS.schema_bundle_bytes)) };
  }
  #close(key: string, transfer: Transfer, now: number): void {
    this.#active.delete(key);
    this.#bytes -= transfer.total;
    this.#closed.set(key, now + LIMITS.transfer_timeout_ms);
  }
  get bufferedBytes(): number {
    return this.#bytes;
  }
  get activeTransfers(): number {
    return this.#active.size;
  }
}
