/** 验证 Luvus socket IO 在写入前收到容量拒绝时原样传播容量类别与回收时间，而不是只剩错误码。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectorCapacityError } from '../../../src/connector/capacity.js'
import { runSocket } from '../../../src/connector/luvus/io.js'

/** 在临时 Unix socket 上启动一个只记录字节的服务，并返回地址与观测状态。 */
function serve() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-io-capacity-'))
  const address = join(root, 'bridge.sock')
  const received: Buffer[] = []
  const sockets = new Set<Socket>()
  const server = createServer(
    /* 登记连接并累积收到的字节，测试结束统一销毁。 */ (socket) => {
      sockets.add(socket)
      socket.on(
        'data',
        /* 记录实际到达服务端的字节，证明容量拒绝发生在写入前。 */ (data) => received.push(Buffer.from(data))
      )
      socket.on('error', /* 消费测试主动断开的连接错误，避免 fixture 自身未处理事件。 */ () => {})
    }
  )
  return new Promise<{ address: string; received: Buffer[]; close(): void }>(
    /* 等待监听就绪后交出观测句柄。 */ (resolve) => {
      server.listen(address, () => {
        resolve({
          address,
          received,
          /* 销毁全部连接并移除临时目录。 */ close() {
            for (const socket of sockets) {
              socket.destroy()
            }
            server.close()
            rmSync(root, { recursive: true, force: true })
          }
        })
      })
    }
  )
}

/** 断言拒绝就是原容量错误：类型、错误码、结果语义与容量内容都完整。 */
function capacityFailure(error: unknown) {
  assert(error instanceof ConnectorCapacityError)
  assert.equal(error.code, 'claim_capacity')
  assert.equal(error.outcome, 'not_dispatched')
  assert.deepEqual(error.capacity, { resource: 'claim_entries', reclaim_at: 1_234_567 })
  return true
}

test(
  'socket ready preparation capacity rejection keeps resource and reclaim time',
  /* 准备阶段（claim 登记）在写入前抛容量错误时，runSocket 必须原样拒绝且服务端收不到任何字节。 */ async (t) => {
    const server = await serve()
    t.after(/* 清理本用例的监听与临时目录。 */ () => server.close())
    await assert.rejects(
      runSocket(
        server.address,
        4096,
        new AbortController().signal,
        /* 在准备帧时直接以容量不足拒绝，模拟账本满额。 */ async () => {
          throw new ConnectorCapacityError('claim_entries', 1_234_567)
        }
      ),
      capacityFailure
    )
    assert.equal(Buffer.concat(server.received).length, 0)
  }
)

test(
  'socket beforeWrite capacity rejection keeps resource and reclaim time',
  /* 帧已准备、紧贴写入的同步复核抛容量错误时，同样原样传播且不写入任何字节。 */ async (t) => {
    const server = await serve()
    t.after(/* 清理本用例的监听与临时目录。 */ () => server.close())
    await assert.rejects(
      runSocket(server.address, 4096, new AbortController().signal, async () => ({
        bytes: Buffer.from('frame'),
        /* 在真正写入前的最终复核处以容量不足拒绝。 */ beforeWrite() {
          throw new ConnectorCapacityError('claim_entries', 1_234_567)
        }
      })),
      capacityFailure
    )
    assert.equal(Buffer.concat(server.received).length, 0)
  }
)
