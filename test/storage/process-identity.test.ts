/** 进程身份与死亡证明：Linux 与 Windows 都用真实子进程验证；其它平台没有证据，一律不算已死。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { currentProcessIdentity, ownerIsDead } from '../../src/storage/process-identity.js'

const supported = process.platform === 'linux' || process.platform === 'win32'

/** 启动一个持续运行的子进程（用当前运行时自身，跨平台）。 */
function child() {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
}

test('自己的身份可取得；活着的其它进程不算已死，PID 相同但启动标识不同才是复用', { skip: !supported }, async () => {
  const own = currentProcessIdentity()
  assert(own)
  assert.equal(own.pid, process.pid)
  const other = child()
  try {
    // 等子进程真正启动并可被查询。
    let identity = currentProcessIdentity(other.pid)
    for (let attempt = 0; !identity && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      identity = currentProcessIdentity(other.pid)
    }
    assert(identity)
    assert.equal(ownerIsDead(identity), false)
    // 同 PID、不同启动标识：原进程已死，PID 被无关进程复用。
    assert.equal(ownerIsDead({ pid: identity.pid, start: identity.start + '0' }), true)
  } finally {
    other.kill()
    await once(other, 'exit')
  }
})

test('子进程被强杀后其身份被证明已死；当前进程自己永远不算已死', { skip: !supported }, async () => {
  const other = child()
  let identity = currentProcessIdentity(other.pid)
  for (let attempt = 0; !identity && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    identity = currentProcessIdentity(other.pid)
  }
  assert(identity)
  other.kill('SIGKILL')
  await once(other, 'exit')
  assert.equal(ownerIsDead(identity), true)
  assert.equal(ownerIsDead(currentProcessIdentity()!), false)
})

test('没有死亡证据的平台：没有身份，也不会判定任何进程已死', { skip: supported }, () => {
  assert.equal(currentProcessIdentity(), undefined)
  assert.equal(ownerIsDead({ pid: 1, start: '1' }), false)
})
