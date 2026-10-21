/** Windows 探测：在真实 Windows runner 上确认 Herdr 的管道名、HERDR_SOCKET_PATH 行为，以及进程身份/对端校验可用的 Win32 入口。
 * 只输出事实（JSON 行），不做断言——结果用来决定 Connector 的 Windows 实现，不是验收。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const emit = (key, value) =>
  console.log(JSON.stringify({ probe: key, ...(typeof value === 'object' ? value : { value }) }))
const root = process.argv[2]
/** 压缩包的目录层级未文档化：递归找 herdr.exe。 */
function locate(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === 'herdr.exe') {
      return path
    }
    if (entry.isDirectory()) {
      const found = locate(path)
      if (found) {
        return found
      }
    }
  }
}
const exe = locate(root) ?? join(root, 'herdr.exe')
emit('platform', {
  platform: process.platform,
  arch: process.arch,
  bun: process.versions.bun,
  exe_exists: existsSync(exe)
})

const work = join(tmpdir(), 'rovloom-herdr-probe')
mkdirSync(work, { recursive: true })
// 隔离 Herdr 的配置/日志位置：Windows 上是 %APPDATA%\herdr。
const env = {
  ...process.env,
  APPDATA: join(work, 'appdata'),
  LOCALAPPDATA: join(work, 'localappdata'),
  USERPROFILE: join(work, 'profile'),
  HOME: join(work, 'profile'),
  TEMP: join(work, 'temp'),
  TMP: join(work, 'temp')
}
for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP']) {
  mkdirSync(env[key], { recursive: true })
}

const version = spawnSync(exe, ['--version'], { env, encoding: 'utf8', timeout: 20_000 })
emit('version', { status: version.status, stdout: version.stdout?.trim(), stderr: version.stderr?.slice(0, 200) })
const schema = spawnSync(exe, ['api', 'schema', '--json'], { env, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
emit('schema', {
  status: schema.status,
  bytes: schema.stdout?.length,
  sha256: schema.stdout ? createHash('sha256').update(schema.stdout).digest('hex') : null,
  stderr: schema.stderr?.toString().slice(0, 200)
})

/** 列出配置目录下的文件，找日志与端点痕迹。 */
function tree(root, depth = 3, prefix = '') {
  const out = []
  if (depth < 0 || !existsSync(root)) {
    return out
  }
  for (const name of readdirSync(root, { withFileTypes: true })) {
    out.push(prefix + name.name + (name.isDirectory() ? '/' : ''))
    if (name.isDirectory()) {
      out.push(...tree(join(root, name.name), depth - 1, prefix + '  '))
    }
  }
  return out
}

/** 向候选管道名发送一行 ping；返回响应或错误码。 */
function ping(path, timeout = 4000) {
  return new Promise((resolve) => {
    const socket = connect(path)
    let data = ''
    const done = (value) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout', data }), timeout)
    socket.on('connect', () => socket.write('{"id":"probe","method":"ping","params":{}}\n'))
    socket.on('data', (chunk) => {
      data += chunk
      if (data.includes('\n')) {
        done({ ok: true, data: data.trim().slice(0, 300) })
      }
    })
    socket.on('error', (error) => done({ ok: false, error: error.code ?? String(error.message), data }))
  })
}

/** 启动一个 Herdr server 子进程，等待片刻，返回日志里的端点信息。 */
async function runServer(label, extraEnv) {
  const child = spawn(exe, ['--session', label, 'server'], {
    env: { ...env, ...extraEnv },
    stdio: 'ignore',
    windowsHide: true
  })
  let exited
  child.once('exit', (code, signal) => (exited = { code, signal }))
  await pause(4000)
  const config = join(env.APPDATA, 'herdr')
  const logs = []
  for (const name of tree(config, 4)) {
    if (name.trim().endsWith('.log')) {
      logs.push(name.trim())
    }
  }
  let logText = ''
  const candidates = [join(config, 'sessions', label, 'herdr-server.log'), join(config, 'herdr-server.log')]
  for (const path of candidates) {
    if (existsSync(path)) {
      logText += readFileSync(path, 'utf8').slice(-1500)
    }
  }
  emit(`server:${label}`, { pid: child.pid, exited: exited ?? null, tree: tree(config, 4), log_tail: logText })
  return { child, logText, exited: () => exited }
}

// 1) 默认命名：看日志里报告的端点（api_socket= / client_socket=）。
const first = await runServer('probe1', {})
const named = /api_socket=(\S+)/u.exec(first.logText)?.[1] ?? /listening path=(\S+)/u.exec(first.logText)?.[1]
emit('discovered_endpoint', { named: named ?? null })
if (named) {
  emit('ping:discovered', await ping(named))
}
emit('ping:guess-pipe', await ping(String.raw`\\.\pipe\herdr-probe1`))
first.child.kill()
await pause(1500)

// 2) HERDR_SOCKET_PATH 指定命名管道：我们能否自己决定管道名。
const pipe = String.raw`\\.\pipe\rovloom-probe-` + process.pid
const second = await runServer('probe2', { HERDR_SOCKET_PATH: pipe })
emit('ping:override-pipe', await ping(pipe))
emit('override_log_mentions_pipe', { value: second.logText.includes('rovloom-probe-') })
second.child.kill()
