/** macOS 原语只在真实 macOS 上执行（CI 的 macos runner）；其它平台跳过，不伪造等价物。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  macosPeer,
  macosProcessArgv,
  macosProcessImage,
  macosProcessState,
  macosProcessUid
} from '../../src/platform/macos.js'

const macos = process.platform === 'darwin'

/** 建立一对已连接的 Unix socket，返回两端及清理函数。 */
async function pair(): Promise<{ client: Socket; accepted: Socket; close(): void }> {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-mac-'))
  const path = join(root, 's')
  const server = createServer()
  const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const client = connect(path)
  await new Promise<void>((resolve) => client.once('connect', resolve))
  const peer = await accepted
  return {
    client,
    accepted: peer,
    close() {
      client.destroy()
      peer.destroy()
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('对端凭据来自内核：两端都是本进程与本用户', { skip: !macos }, async () => {
  const sockets = await pair()
  try {
    for (const socket of [sockets.client, sockets.accepted]) {
      const peer = macosPeer(socket)
      assert.equal(peer.pid, process.pid)
      assert.equal(peer.uid, process.geteuid!())
      assert.equal(peer.gid, process.getegid!())
    }
  } finally {
    sockets.close()
  }
})

test('已关闭或未连接的 socket 没有对端', { skip: !macos }, async () => {
  const sockets = await pair()
  sockets.close()
  assert.throws(() => macosPeer(sockets.client), { code: 'macos_peer_unavailable' })
})

test('子进程的状态、镜像、命令行与属主', { skip: !macos }, async () => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  try {
    const pid = child.pid!
    await new Promise<void>((resolve) => child.once('spawn', resolve))
    const state = macosProcessState(pid)
    assert.equal(state.kind, 'alive')
    assert.match((state as { start: string }).start, /^\d+\.\d{6}$/u)
    assert.deepEqual(macosProcessState(pid), state)
    assert.equal(macosProcessImage(pid), realpathSync('/bin/sleep'))
    assert.deepEqual(macosProcessArgv(pid)?.slice(1), ['30'])
    assert.equal(macosProcessUid(pid), process.geteuid!())
  } finally {
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  assert.equal(macosProcessState(child.pid!).kind, 'dead')
})

test('自己的进程身份：镜像是当前运行时，启动时间稳定', { skip: !macos }, () => {
  const first = macosProcessState(process.pid)
  assert.equal(first.kind, 'alive')
  assert.deepEqual(macosProcessState(process.pid), first)
  assert.equal(macosProcessImage(process.pid), realpathSync(process.execPath))
  assert.equal(macosProcessArgv(process.pid)?.[0] !== undefined, true)
})

test('无效 pid 不会被当作已死', { skip: !macos }, () => {
  assert.deepEqual(macosProcessState(0), { kind: 'unknown' })
  assert.deepEqual(macosProcessState(-1), { kind: 'unknown' })
  assert.equal(macosProcessImage(2_147_483_000), undefined)
  assert.equal(macosProcessArgv(2_147_483_000), undefined)
})

test('非 macOS 上调用原语直接拒绝', { skip: macos }, () => {
  assert.deepEqual(macosProcessState(process.pid), { kind: 'unknown' })
  assert.equal(macosProcessImage(process.pid), undefined)
  assert.equal(macosProcessArgv(process.pid), undefined)
})
