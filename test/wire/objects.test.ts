// 验证对象分片重组的资源边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ObjectAssembler,
  fragmentObject,
  LIMITS,
  encodeWireFrame,
  decodeWireFrame,
  boundedJson,
  hash
} from '../../src/wire/index.js'
import { bundle, response, frame, attempt, context, rejects } from './helpers.js'

test(
  '真实 P0 bundle 跨多个分片重组，bundle 限额独立于 message 与普通对象',
  /* 验证真实 P0 bundle 跨多个分片重组，bundle 限额独立于 message 与普通对象。 */ () => {
    const ctx = context('connector_to_gateway')
    const chunks = fragmentObject(bundle, 'schema_bundle', 'schema_1', ctx)
    assert(chunks.length >= 2)
    const assembler = new ObjectAssembler()
    assert.equal(assembler.push(chunks[0]!, ctx, 100), undefined)
    assert.equal(assembler.push(chunks[0]!, ctx, 101), undefined)
    let result: ReturnType<ObjectAssembler['push']>
    for (const chunk of chunks.slice(1)) {
      result = assembler.push(chunk, ctx, 102)
    }
    assert.deepEqual(result!, { kind: 'schema_bundle', bundle })
    assert.equal(assembler.activeTransfers, 0)
    assert.equal(assembler.bufferedBytes, 0)
    rejects(
      /* 提交该用例输入，确认对象已完成或超时并留下墓碑时被拒绝。 */ () => assembler.push(chunks[0]!, ctx, 103),
      'object_closed'
    )
    const bad = structuredClone(chunks[0]!)
    delete (bad.payload as any).sha256
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () => decodeWireFrame(JSON.stringify(bad), ctx),
      'invalid_frame_fields'
    )
    rejects(
      /* 提交该用例输入，确认消息传输方向错误时被拒绝。 */ () =>
        fragmentObject(bundle, 'schema_bundle', 'wrong_direction', context()),
      'wrong_direction'
    )
    rejects(
      /* 提交该用例输入，确认JSON 超过当前序列化字节上限时被拒绝。 */ () =>
        fragmentObject({ data: 'x'.repeat(LIMITS.schema_bundle_bytes) }, 'schema_bundle', 'too_big', ctx),
      'json_size_limit'
    )
  }
)

test(
  '超过 frame 限额的完整 response 走有界对象，重组后再次执行原生/schema/身份门禁',
  /* 验证超过 frame 限额的完整 response 走有界对象，重组后再次执行原生/schema/身份门禁。 */ () => {
    const ctx = context('connector_to_gateway')
    const big = {
      ...response,
      payload: {
        ...response.payload,
        native_response: {
          id: attempt.native_request_id,
          result: { synthetic: 'x'.repeat(LIMITS.frame_bytes) }
        }
      }
    }
    rejects(
      /* 提交该用例输入，确认JSON 超过当前序列化字节上限时被拒绝。 */ () => encodeWireFrame(big, ctx),
      'json_size_limit'
    )
    const chunks = fragmentObject(big, 'envelope', 'large_1', ctx)
    const assembler = new ObjectAssembler()
    let result: ReturnType<ObjectAssembler['push']>
    for (const chunk of chunks) {
      result = assembler.push(chunk, ctx, 1)
    }
    assert.deepEqual(result!, { kind: 'envelope', envelope: big })
    const oversized = {
      ...big,
      payload: {
        ...big.payload,
        native_response: {
          id: attempt.native_request_id,
          result: { data: 'x'.repeat(LIMITS.object_bytes) }
        }
      }
    }
    rejects(
      /* 提交该用例输入，确认JSON 超过当前序列化字节上限时被拒绝。 */ () =>
        fragmentObject(oversized, 'envelope', 'too_big', ctx),
      'json_size_limit'
    )
    const invalid = {
      ...response,
      payload: {
        ...response.payload,
        native_response: { id: attempt.native_request_id, extra: true, result: {} }
      }
    }
    // 即便直接构造正确 checksum 的分片，重组后的原生根字段也不能绕过校验。
    const raw = boundedJson(invalid)
    const handcrafted = frame('object_chunk', {
      object_id: 'invalid_1',
      kind: 'envelope',
      total_bytes: Buffer.byteLength(raw),
      sha256: hash(raw),
      chunk_count: 1,
      index: 0,
      data: Buffer.from(raw).toString('base64')
    })
    rejects(
      /* 提交该用例输入，确认原生响应未通过校验时被拒绝。 */ () => new ObjectAssembler().push(handcrafted, ctx, 0),
      'native_response_invalid'
    )
  }
)

test(
  '分片拒绝错序、冲突、checksum、超时、错误关联与容量洪泛',
  /* 验证分片拒绝错序、冲突、checksum、超时、错误关联与容量洪泛。 */ () => {
    const ctx = context('connector_to_gateway')
    const chunks = fragmentObject(bundle, 'schema_bundle', 'schema_1', ctx)
    const assembler = new ObjectAssembler()
    rejects(
      /* 提交该用例输入，确认分片未按连续索引到达时被拒绝。 */ () => assembler.push(chunks[1]!, ctx, 0),
      'chunk_out_of_order'
    )
    assembler.push(chunks[0]!, ctx, 0)
    const changed = structuredClone(chunks[0]!)
    changed.payload.data = Buffer.alloc(LIMITS.chunk_bytes, 120).toString('base64')
    rejects(
      /* 提交该用例输入，确认重复分片的实际字节冲突时被拒绝。 */ () => assembler.push(changed, ctx, 1),
      'chunk_conflict'
    )
    assert.equal(assembler.bufferedBytes, 0)
    const altered = new ObjectAssembler()
    altered.push(chunks[0]!, ctx, 0)
    rejects(
      /* 提交该用例输入，确认同一对象的分片描述符冲突时被拒绝。 */ () =>
        altered.push({ ...chunks[1]!, payload: { ...chunks[1]!.payload, sha256: 'b'.repeat(64) } }, ctx, 1),
      'object_conflict'
    )
    const checksum = fragmentObject(bundle, 'schema_bundle', 'checksum_1', ctx).map(
      /* 篡改每片的声明摘要，构造分片一致但最终校验失败的传输。 */ (c) => ({
        ...c,
        payload: { ...c.payload, sha256: 'b'.repeat(64) }
      })
    )
    const check = new ObjectAssembler()
    for (const c of checksum.slice(0, -1)) {
      check.push(c, ctx, 0)
    }
    rejects(
      /* 提交该用例输入，确认重组对象摘要与声明值不一致时被拒绝。 */ () => check.push(checksum.at(-1)!, ctx, 0),
      'object_checksum'
    )
    const timeout = new ObjectAssembler()
    timeout.push(chunks[0]!, ctx, 100)
    timeout.push(chunks[0]!, ctx, 100 + LIMITS.transfer_timeout_ms - 1)
    rejects(
      /* 提交该用例输入，确认对象已完成或超时并留下墓碑时被拒绝。 */ () =>
        timeout.push(chunks[1]!, ctx, 100 + LIMITS.transfer_timeout_ms),
      'object_closed'
    )
    assert.equal(timeout.bufferedBytes, 0)
    rejects(
      /* 提交该用例输入，确认消息与当前连接身份不匹配时被拒绝。 */ () =>
        new ObjectAssembler().push({ ...chunks[0]!, connection_epoch: 'old' }, ctx, 0),
      'connection_binding_mismatch'
    )
    rejects(
      /* 提交该用例输入，确认分片数据不是规范 base64 或长度非法时被拒绝。 */ () =>
        encodeWireFrame({ ...chunks[0]!, payload: { ...chunks[0]!.payload, data: 'not-base64' } }, ctx),
      'invalid_chunk'
    )
    rejects(
      /* 提交该用例输入，确认对象总长或分片数量不符合协议约束时被拒绝。 */ () =>
        encodeWireFrame({ ...chunks[0]!, payload: { ...chunks[0]!.payload, chunk_count: 999 } }, ctx),
      'object_limit'
    )
    const capacity = new ObjectAssembler()
    for (let i = 0; i < LIMITS.transfers; i++) {
      capacity.push(fragmentObject(bundle, 'schema_bundle', `capacity_${i}`, ctx)[0]!, ctx, 0)
    }
    rejects(
      /* 提交该用例输入，确认活动传输或预约字节容量已满时被拒绝。 */ () =>
        capacity.push(fragmentObject(bundle, 'schema_bundle', 'capacity_full', ctx)[0]!, ctx, 0),
      'object_capacity'
    )
    assert.equal(capacity.activeTransfers, LIMITS.transfers)
    assert.doesNotThrow(
      /* 验证达到标识长度上限的对象仍能分片。 */ () => fragmentObject(response, 'envelope', 'a'.repeat(128), ctx)
    )
  }
)

test(
  '分片预约字节容量拒绝第二个11MiB对象，首次传输仍保持有界',
  /* 保留原11MiB预约边界，独立计时；复用合法首片，避免为只消费一片的断言重复生成整对象分片。 */ () => {
    const ctx = context('connector_to_gateway')
    const byteCapacity = new ObjectAssembler()
    const big = { data: 'x'.repeat(11 * LIMITS.frame_bytes) }
    const first = fragmentObject(big, 'schema_bundle', 'large_schema_1', ctx)[0]!
    byteCapacity.push(first, ctx, 0)
    assert.equal(byteCapacity.activeTransfers, 1)
    const second = {
      ...first,
      message_id: 'capacity_bytes_second',
      payload: { ...first.payload, object_id: 'large_schema_2' }
    }
    rejects(
      /* 第二传输同样声明完整11MiB；失败来自总预约字节，而非传输数、重复ID或片内容不合法。 */ () =>
        byteCapacity.push(second, ctx, 0),
      'object_capacity'
    )
    assert.equal(byteCapacity.activeTransfers, 1)
  }
)
