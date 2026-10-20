// 只验证封闭 IPC/事务字节及退出码，不把纯逻辑视作 Windows 替换或权限验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../fixtures.js'
import { updatePlatform } from '../../../src/update/contract.js'
import { checkForUpdate } from '../../../src/update/plan.js'
import {
  openWindowsJob,
  parseWindowsReceipt,
  parseWindowsTicket,
  sealWindowsJob,
  windowsReceiptExit
} from '../../../src/update/windows/protocol.js'

const parent = { image: 'C:\\Program Files\\Rovloom\\rovloom.exe', born: '134000000000000000' }
const resources = {
  transactionId: 'cd'.repeat(16),
  directory: { volume: '12345', fileId: 'ef'.repeat(16), security: 'a'.repeat(64) }
}
const original = {
  volume: '12345',
  fileId: 'ab'.repeat(16),
  size: 100,
  sha256: 'a'.repeat(64),
  security: 'b'.repeat(64)
}

// 官方 release/manifest 均注入固定内存数据，不读取外部资产或真实安装。
async function plan() {
  const platform = updatePlatform('win32', 'x64')
  const f = fixture(platform, '0.2.0')
  return checkForUpdate(f.network, '0.1.0', platform)
}

test(
  'Windows helper seals one official plan and local installation identity without serializing its IPC secret',
  /* MAC 仅对本次固定字节进行绑定，不是发行签名认证。 */ async () => {
    const sealed = sealWindowsJob(await plan(), parent, original, resources)
    const opened = openWindowsJob(sealed.bytes, sealed.ticket)
    assert.deepEqual(opened.job, sealed.job)
    assert.equal(opened.digest, sealed.digest)
    assert.equal(Buffer.from(sealed.bytes).includes(sealed.ticket.secret), false)
    assert.equal(Object.isFrozen(opened.job), true)
    assert.equal(Object.isFrozen(opened.job.plan.asset), true)
    assert.deepEqual(parseWindowsTicket(Buffer.from(JSON.stringify(sealed.ticket))), sealed.ticket)
  }
)

test(
  'Windows helper rejects tampered bytes, wrong credential, noncanonical base64 and extra URL/PID fields',
  /* 不从 IPC 建立任意路径、PID、镜像或脚本通路。 */ async () => {
    const sealed = sealWindowsJob(await plan(), parent, original, resources)
    const envelope = JSON.parse(Buffer.from(sealed.bytes).toString())
    const changed = Buffer.from(envelope.payload, 'base64')
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1
    for (const value of [
      { ...envelope, payload: changed.toString('base64') },
      { ...envelope, payload: envelope.payload + '\n' },
      { ...envelope, url: 'https://other.invalid/binary.exe' }
    ]) {
      assert.throws(
        /* 任何改变都不能通过原始字节封存校验。 */ () =>
          openWindowsJob(Buffer.from(JSON.stringify(value)), sealed.ticket),
        { code: 'invalid_manifest' }
      )
    }
    assert.throws(
      /* 另一次事务凭据不授予当前能力。 */ () =>
        openWindowsJob(sealed.bytes, { ...sealed.ticket, secret: '0'.repeat(64) }),
      { code: 'invalid_manifest' }
    )
    assert.throws(
      /* 原始票据也为封闭字段集。 */ () =>
        parseWindowsTicket(Buffer.from(JSON.stringify({ ...sealed.ticket, pid: 1 }))),
      { code: 'invalid_manifest' }
    )
    const p = await plan()
    assert.throws(
      /* 生产端不能封存带任意 URL 的伪计划。 */ () =>
        sealWindowsJob({ ...p, url: 'https://other.invalid' } as never, parent, original, resources),
      { code: 'invalid_manifest' }
    )
    assert.throws(
      /* 当前版本之后必须为更高的稳定版本。 */ () =>
        sealWindowsJob({ ...p, currentVersion: '0.3.0' }, parent, original, resources),
      { code: 'invalid_manifest' }
    )
  }
)

test(
  'only committed Windows helper receipts are successful and all other states stay distinguishable',
  /* 下载、准备、已替换未验证都不能退出零；回滚完成与需恢复分别有固定非零码。 */ async () => {
    const sealed = sealWindowsJob(await plan(), parent, original, resources)
    const base = {
      schemaVersion: 1,
      transactionId: sealed.job.transactionId,
      jobSha256: sealed.digest,
      sequence: 1,
      exitCode: null
    }
    const states = [
      'awaiting_parent',
      'prepared',
      'replacing',
      'replaced',
      'updated',
      'rolling_back',
      'rolled_back',
      'aborted',
      'recovery_required',
      'cleanup_required'
    ]
    for (const state of states) {
      const code = ['rolled_back', 'aborted', 'recovery_required', 'cleanup_required'].includes(state)
        ? 'verification_failed'
        : null
      const exitCode =
        state === 'updated'
          ? 0
          : state === 'rolled_back'
            ? 6
            : state === 'recovery_required'
              ? 7
              : ['aborted', 'cleanup_required'].includes(state)
                ? 4
                : null
      const receipt = parseWindowsReceipt(Buffer.from(JSON.stringify({ ...base, state, code, exitCode })))
      const expected =
        state === 'updated'
          ? 0
          : state === 'rolled_back'
            ? 6
            : ['replacing', 'replaced', 'rolling_back', 'recovery_required'].includes(state)
              ? 7
              : 4
      assert.equal(windowsReceiptExit(receipt), expected)
    }
    for (const exitCode of [1, 2, 3, 4, 5]) {
      const aborted = parseWindowsReceipt(
        Buffer.from(JSON.stringify({ ...base, state: 'aborted', code: 'verification_failed', exitCode }))
      )
      assert.equal(windowsReceiptExit(aborted), exitCode)
    }
    for (const value of [
      { ...base, state: 'updated', code: 'verification_failed', exitCode: 0 },
      { ...base, state: 'rolled_back', code: null, exitCode: 6 },
      { ...base, state: 'updated', code: null, exitCode: 0, error: 'raw native output' },
      { ...base, state: 'recovery_required', code: 'unreviewed_error' }
    ]) {
      assert.throws(
        /* 未知字段、未确认失败和错误原文都不能进入回执。 */ () =>
          parseWindowsReceipt(Buffer.from(JSON.stringify(value))),
        { code: 'invalid_manifest' }
      )
    }
  }
)
