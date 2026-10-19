// 用真实Bun/SDK stdio和自有慢Writable核对输出预算、背压停读及关闭后的写错误；不提供业务后端。
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { MAX_MCP_BYTES, startStdioFacade } from '../../src/mcp/index.js'

// 让真实SDK的Promise、Writable回调和drain推进一轮，不用长sleep掩盖生命周期问题。
async function turn(): Promise<void> {
  await new Promise<void>(/* 只等待本地事件循环下一轮。 */ (resolve) => setImmediate(resolve))
}

// 持有自有物理写回调，测试可精确控制慢写、永不排空及晚到EPIPE。
async function fixture(t: TestContext, highWaterMark = 1) {
  const stdin = new PassThrough()
  const frames: { id?: string | number }[] = []
  const pending: ((error?: Error) => void)[] = []
  const diagnostics: string[] = []
  const stdout = new Writable({
    highWaterMark,
    write: /* 记录实际标准帧，故意由测试决定何时完成本次底层写。 */ (chunk, _encoding, callback) => {
      frames.push(JSON.parse(Buffer.from(chunk).toString('utf8')))
      pending.push(callback)
    }
  })
  const running = await startStdioFacade({
    stdin,
    stdout,
    caller: { resolve: /* ping只走真实SDK，不应建立任何业务身份。 */ () => null },
    service: {
      execute: /* 此明确拒绝的服务fixture不参与任何native或授权成功证明。 */ async () => {
        throw new Error('unexpected_service')
      }
    },
    diagnostic: /* 只收集固定公开代码，原始底层错误不得进入诊断。 */ (code) => diagnostics.push(code)
  })
  t.after(
    /* 失败路径也终止协议并释放本例持有的回调，不能把未完成写带入后续测试。 */ async () => {
      await running.close()
      for (const callback of pending.splice(0)) {
        callback(new Error('fixture_closed'))
      }
      stdin.destroy()
      stdout.destroy()
      await turn()
    }
  )
  const send = /* 写入标准客户端消息，不直接调用私有transport或SDK处理器。 */ (value: unknown) =>
    stdin.write(JSON.stringify(value) + '\n')
  send({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'isolated-backpressure', version: '1' }
    }
  })
  await turn()
  return {
    stdin,
    stdout,
    frames,
    diagnostics,
    running,
    send,
    release: /* 只结算测试实际持有的一次物理写，不伪造额外drain。 */ (error?: Error) => {
      const callback = pending.shift()
      assert(callback)
      callback(error)
    }
  }
}

test(
  '慢stdout暂停真实协议输入，排空后恢复且回复不丢失或重复',
  /* 验证callback与drain共同控制发送生命周期。 */ async (t) => {
    const f = await fixture(t)
    assert.equal(f.frames.length, 1)
    assert.equal(f.stdin.isPaused(), true)
    assert.equal(f.stdout.listenerCount('drain'), 1)
    f.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    f.send({ jsonrpc: '2.0', id: 'slow', method: 'ping' })
    await turn()
    assert.equal(f.frames.length, 1)
    f.release()
    await turn()
    assert.equal(f.frames.length, 2)
    assert.equal(f.frames[1]!.id, 'slow')
    f.release()
    await turn()
    assert.equal(f.stdin.isPaused(), false)
    assert.equal(f.stdout.listenerCount('drain'), 0)
    assert.deepEqual(f.diagnostics, [])
  }
)

test(
  '永不drain的stdout不会逐请求积累监听，显式关闭清理后晚到EPIPE仍被观察',
  /* 复现5000 ping原边界。 */ async (t) => {
    const f = await fixture(t)
    for (let batch = 0; batch < 50; batch++) {
      for (let index = 0; index < 100; index++) {
        f.send({ jsonrpc: '2.0', id: batch * 100 + index, method: 'ping' })
      }
      await turn()
    }
    assert.equal(f.frames.length, 1)
    assert(f.stdout.writableLength <= MAX_MCP_BYTES)
    assert.equal(f.stdout.listenerCount('drain'), 1)
    assert.equal(f.stdin.isPaused(), true)
    await f.running.close()
    await turn()
    assert.equal(f.stdout.listenerCount('drain'), 0)
    assert.equal(f.stdout.listenerCount('error'), 0)
    f.release(new Error('/private/SYNTHETIC_SECRET_EPIPE'))
    await turn()
    assert.equal(f.stdout.writableLength, 0)
    assert.deepEqual(f.diagnostics, ['mcp_transport_error'])
  }
)

test(
  '单chunk的回复洪泛也受有界输出队列约束，超限关闭而不形成无限SDK等待',
  /* 覆盖停读前已解析的消息。 */ async (t) => {
    const f = await fixture(t)
    f.release()
    await turn()
    f.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    f.stdin.write(
      Array.from(
        { length: 100 },
        /* 同一输入chunk可在首个回复产生前被SDK完整解析。 */ (_, id) =>
          JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n'
      ).join('')
    )
    await f.running.closed
    await turn()
    assert.equal(f.stdout.destroyed, true)
    assert.equal(f.frames.length, 2)
    assert(f.stdout.writableLength <= MAX_MCP_BYTES)
    assert.equal(f.stdout.listenerCount('drain'), 0)
    f.release(new Error('fixture_closed'))
    await turn()
    assert.equal(f.stdout.listenerCount('error'), 0)
    assert.deepEqual(f.diagnostics, ['mcp_transport_error'])
  }
)

test(
  '活动物理写的EPIPE关闭协议并脱敏，不形成uncaughtException',
  /* 实际Writable错误路径也结算SDK发送。 */ async (t) => {
    const f = await fixture(t)
    f.release(new Error('/private/SYNTHETIC_SECRET_EPIPE'))
    await f.running.closed
    await turn()
    assert.equal(f.stdout.listenerCount('drain'), 0)
    assert.equal(f.stdout.listenerCount('error'), 0)
    assert.deepEqual(f.diagnostics, ['mcp_transport_error'])
  }
)

test(
  'EOF关闭后已接受的异步写报EPIPE仍安全结算，关闭不提前丢掉错误归属',
  /* 覆盖write返回true的晚到错误。 */ async (t) => {
    const f = await fixture(t, 1_048_576)
    assert.equal(f.stdin.isPaused(), false)
    f.stdin.end()
    await f.running.closed
    await turn()
    assert.equal(f.stdout.listenerCount('drain'), 0)
    f.release(new Error('/private/SYNTHETIC_SECRET_EPIPE'))
    await turn()
    assert.equal(f.stdout.writableLength, 0)
    assert.equal(f.stdout.listenerCount('error'), 0)
    assert.deepEqual(f.diagnostics, ['mcp_transport_error'])
  }
)

test(
  '空闲stdout销毁与会话关闭并发时，终止事件前仍观察迟到EPIPE',
  /* 没有活动写也可能已有待发出的流错误，不能只按发送队列决定移除监听。 */ async (t) => {
    const f = await fixture(t, 1_048_576)
    f.release()
    await turn()
    f.stdout.destroy(new Error('/private/SYNTHETIC_SECRET_EPIPE'))
    await f.running.close()
    await turn()
    assert.equal(f.stdout.listenerCount('error'), 0)
    assert.equal(f.stdout.listenerCount('close'), 0)
    assert.deepEqual(f.diagnostics, ['mcp_transport_error'])
  }
)

test(
  '非法参数的排队错误可取消，复用公共ID只收到新请求回复',
  /* 高水位允许继续读入，固定参数错误也必须参与真实关联和取消。 */ async (t) => {
    const f = await fixture(t, 1_048_576)
    f.release()
    await turn()
    f.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    f.send({ jsonrpc: '2.0', id: 'held', method: 'ping' })
    await turn()
    f.send({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 123 } })
    f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 0 } })
    f.send({ jsonrpc: '2.0', id: 0, method: 'ping' })
    await turn()
    assert.deepEqual(
      f.frames.map(/* 提交到物理输出的帧不含仍在排队的参数错误。 */ (frame) => frame.id),
      ['initialize', 'held']
    )
    f.release()
    await turn()
    assert.deepEqual(f.frames.at(-1), { jsonrpc: '2.0', id: 0, result: {} })
    assert.equal(f.frames.length, 3)
    f.release()
    await turn()
    assert.deepEqual(f.diagnostics, [])
  }
)

test(
  '已提交回复的公共ID可立即复用，旧写回调不清除新请求关联',
  /* 模拟客户端已收到完整帧但底层回调尚未完成，随后发出的取消应关联新等待。 */ async (t) => {
    const f = await fixture(t, 1_048_576)
    f.release()
    await turn()
    f.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    f.send({ jsonrpc: '2.0', id: '', method: 'ping' })
    await turn()
    assert.equal(f.frames.at(-1)?.id, '')
    f.send({ jsonrpc: '2.0', id: '', method: 'ping' })
    await turn()
    f.release()
    await turn()
    assert.equal(f.frames.length, 3)
    f.send({ jsonrpc: '2.0', id: '', method: 'ping' })
    f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '' } })
    await turn()
    f.release()
    await turn()
    assert.equal(f.frames.length, 3)
    assert.deepEqual(f.diagnostics, [])
  }
)
