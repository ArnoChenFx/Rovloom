/** 只用自建 Unix socket 检验真实内核 peer 测量，不把测量结果冒称 native 实例归属。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLinuxLuvusPeer } from '../../../src/connector/luvus/linux-peer.js'
import { LuvusAdapterError } from '../../../src/connector/luvus/types.js'

test(
  'SO_PEERCRED is measured from the actual connected socket and closed sockets fail',
  /** 本进程自建 listener 的 peer 必须是本进程，而非任何自报 endpoint 字段。 */ async () => {
    const root = mkdtempSync(
      join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url)), '.luvus-peer-')
    )
    const path = join(root, 'rpc.sock')
    const accepted = new Set<Socket>()
    const server = createServer(
      /* 只保留自己的连接以便最后完整清理。 */ (socket) => {
        accepted.add(socket)
      }
    )
    let socket: Socket | undefined
    try {
      await new Promise<void>(
        /* 等待自建 Unix listener 完成绑定。 */ (resolve, reject) => {
          server.once('error', reject)
          server.listen(path, resolve)
        }
      )
      chmodSync(path, 0o600)
      socket = createConnection({ path })
      await new Promise<void>(
        /* 等待同一客户端 socket 真正连接，不替换 fd。 */ (resolve, reject) => {
          socket!.once('error', reject)
          socket!.once('connect', resolve)
        }
      )
      const peer = readLinuxLuvusPeer(socket)
      assert.deepEqual(peer, { pid: process.pid, uid: process.geteuid!(), gid: process.getegid!() })
      assert(Object.isFrozen(peer))
      socket.destroy()
      assert.throws(
        /* 已关闭 socket 不可复用先前的内核测量。 */ () => readLinuxLuvusPeer(socket!),
        /* 公开异常不携带 libc 错误或路径。 */ (error: unknown) => {
          assert(error instanceof LuvusAdapterError)
          assert.equal(error.code, 'linux_peer_unavailable')
          assert.equal(error.message, error.code)
          return true
        }
      )
      assert.throws(
        /* 同形 JSON 不是操作系统 socket。 */ () => readLinuxLuvusPeer({ _handle: { fd: 0 } } as unknown as Socket),
        LuvusAdapterError
      )
    } finally {
      socket?.destroy()
      for (const client of accepted) {
        client.destroy()
      }
      await new Promise<void>(
        /* 关闭自建 listener 后删除自有私有目录。 */ (resolve) => server.close(/* 完成关闭等待。 */ () => resolve())
      )
      rmSync(root, { recursive: true, force: true })
    }
  }
)
