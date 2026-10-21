/** Windows 原语只在真实 Windows 上执行（CI 的 windows runner）；其它平台跳过，不伪造等价物。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  windowsCurrentUserSid,
  windowsInspectPath,
  windowsPathFacts,
  windowsPipeServerPid,
  windowsProcessFacts
} from '../../src/platform/windows.js'

const windows = process.platform === 'win32'

test('当前用户 SID 是 SID 文本', { skip: !windows }, () => {
  assert.match(windowsCurrentUserSid(), /^S-1-\d+(-\d+)+$/u)
})

test('自己的临时目录可信；文件类型不符被拒绝', { skip: !windows }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-win-'))
  try {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')
    assert.match(windowsInspectPath(root, 'directory'), /rovloom-win-/u)
    assert.match(windowsInspectPath(file, 'file'), /a\.txt/u)
    assert.throws(() => windowsInspectPath(file, 'directory'), { code: 'windows_path_untrusted' })
    assert.throws(() => windowsInspectPath(root, 'file'), { code: 'windows_path_untrusted' })
    assert.throws(() => windowsInspectPath('relative\\path', 'directory'), { code: 'windows_path_invalid' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('范围过宽的主体可写时路径不再可信', { skip: !windows }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-win-'))
  try {
    const open = join(root, 'open')
    mkdirSync(open)
    assert.equal(windowsPathFacts(open).broad_write, false)
    execFileSync('icacls', [open, '/grant', '*S-1-1-0:(OI)(CI)M'], { stdio: 'ignore' })
    assert.equal(windowsPathFacts(open).broad_write, true)
    assert.throws(() => windowsInspectPath(open, 'directory'), { code: 'windows_path_untrusted' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('系统二进制可作为可信安装路径', { skip: !windows }, () => {
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  assert.match(windowsInspectPath(join(system, 'System32', 'cmd.exe'), 'binary'), /cmd\.exe/u)
})

test('命名管道服务端 pid 来自内核', { skip: !windows }, async () => {
  const name = `\\\\.\\pipe\\rovloom-test-${process.pid}-${Date.now()}`
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(name, resolve))
  try {
    assert.equal(windowsPipeServerPid(name), process.pid)
  } finally {
    server.close()
  }
  assert.throws(() => windowsPipeServerPid(name + '-missing'), { code: 'windows_pipe_unavailable' })
})

test('进程镜像与创建时间：自己存在，不存在的 pid 返回 undefined', { skip: !windows }, () => {
  const facts = windowsProcessFacts(process.pid)
  assert(facts)
  assert.match(facts.image, /\.exe$/iu)
  assert(facts.created > 0n)
  assert.equal(windowsProcessFacts(0), undefined)
  assert.equal(windowsProcessFacts(4_000_000_000), undefined)
})

test('非 Windows 平台拒绝调用', { skip: windows }, () => {
  assert.throws(() => windowsCurrentUserSid(), { code: 'windows_platform_required' })
})
