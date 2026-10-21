/** Windows 探测第二轮：官方 Herdr 的端点是文件系统路径（疑似 AF_UNIX）。确认能用什么连上、能否取得对端 pid，
 * 以及 HERDR_SOCKET_PATH 对文件路径是否生效。只输出事实（JSON 行），不做断言——结果用于决定 Connector 的 Windows 实现。
 */
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const emit = (key, value) =>
  console.log(JSON.stringify({ probe: key, ...(typeof value === 'object' ? value : { value }) }))
const root = process.argv[2]
/** 压缩包的目录层级：递归找 herdr.exe。 */
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
const exe = locate(root)
emit('platform', { platform: process.platform, arch: process.arch, bun: process.versions.bun, exe })

const work = join(tmpdir(), 'rovloom-herdr-probe2')
mkdirSync(work, { recursive: true })
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

/** 启动一个 Herdr server，等待就绪，返回子进程与日志里报告的 api 端点。 */
async function server(label, extraEnv = {}) {
  const child = spawn(exe, ['--session', label, 'server'], {
    env: { ...env, ...extraEnv },
    stdio: 'ignore',
    windowsHide: true
  })
  await pause(4000)
  const logPath = join(env.APPDATA, 'herdr', 'sessions', label, 'herdr-server.log')
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const api = /api_socket=(\S+)/u.exec(log)?.[1]
  return { child, api, log }
}

/** 用 PowerShell 7（.NET）的 AF_UNIX 客户端连端点：ping、取对端 pid、读文件属性与 ACL。 */
function dotnetProbe(path, expectedPid) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
try {
  $item = Get-Item -LiteralPath $env:PROBE_PATH -Force
  $out.attributes = [string]$item.Attributes
  $out.link_type = [string]$item.LinkType
  $out.length = $item.Length
  $acl = Get-Acl -LiteralPath $env:PROBE_PATH
  $out.owner = $acl.Owner
  $out.access = @($acl.Access | ForEach-Object { "$($_.IdentityReference):$($_.FileSystemRights):$($_.AccessControlType)" })
  $dirAcl = Get-Acl -LiteralPath (Split-Path $env:PROBE_PATH)
  $out.dir_owner = $dirAcl.Owner
  $out.dir_access = @($dirAcl.Access | ForEach-Object { "$($_.IdentityReference):$($_.FileSystemRights):$($_.AccessControlType)" })
} catch { $out.file_error = $_.Exception.Message }
try {
  $ep = [System.Net.Sockets.UnixDomainSocketEndPoint]::new($env:PROBE_PATH)
  $s = [System.Net.Sockets.Socket]::new([System.Net.Sockets.AddressFamily]::Unix, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Unspecified)
  $s.ReceiveTimeout = 4000
  $s.Connect($ep)
  $out.connected = $true
  $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"id":"probe","method":"ping","params":{}}' + [char]10)
  [void]$s.Send($bytes)
  $buffer = [byte[]]::new(4096)
  $count = $s.Receive($buffer)
  $out.reply = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $count).Trim()
  # SIO_AF_UNIX_GETPEERPID = _WSAIOR(IOC_VENDOR, 256)
  try {
    $pidBytes = [byte[]]::new(4)
    [void]$s.IOControl([int]0x58000100, [byte[]]::new(0), $pidBytes)
    $out.peer_pid = [BitConverter]::ToUInt32($pidBytes, 0)
  } catch { $out.peer_pid_error = $_.Exception.Message }
  $s.Dispose()
} catch { $out.connect_error = $_.Exception.Message }
try {
  $p = Get-Process -Id $env:EXPECTED_PID
  $out.process_path = $p.Path
  $out.process_start = $p.StartTime.ToFileTimeUtc()
} catch { $out.process_error = $_.Exception.Message }
$out | ConvertTo-Json -Compress -Depth 4
`
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PROBE_PATH: path, EXPECTED_PID: String(expectedPid) },
    encoding: 'utf8',
    timeout: 60_000
  })
  return { status: result.status, stdout: result.stdout?.trim().slice(-3000), stderr: result.stderr?.slice(0, 500) }
}

/** Bun 自己的 unix socket 客户端能否连上同一路径。 */
function bunConnect(path) {
  return new Promise((resolve) => {
    let data = ''
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout', data }), 5000)
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write('{"id":"probe","method":"ping","params":{}}\n')
        },
        data(socket, chunk) {
          data += Buffer.from(chunk).toString('utf8')
          if (data.includes('\n')) {
            clearTimeout(timer)
            socket.end()
            resolve({ ok: true, data: data.trim().slice(0, 300) })
          }
        },
        error(_socket, error) {
          clearTimeout(timer)
          resolve({ ok: false, error: String(error?.code ?? error?.message ?? error) })
        }
      }
    }).catch((error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(error?.code ?? error?.message ?? error) })
    })
  })
}

/** node:net 按路径/管道名连接（Windows 上按命名管道处理）并 ping。 */
function pingPath(path) {
  return new Promise((resolve) => {
    let data = ''
    const socket = connect(path)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ ok: false, error: 'timeout', data })
    }, 5000)
    socket.on('connect', () => socket.write('{"id":"probe","method":"ping","params":{}}\n'))
    socket.on('data', (chunk) => {
      data += chunk
      if (data.includes('\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve({ ok: true, data: data.trim().slice(0, 300) })
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.code ?? String(error.message) })
    })
  })
}

// 1) 默认会话的端点：.NET 与 Bun 各试一次，并读文件属性/ACL、对端 pid、server 进程路径与启动时间。
const first = await server('probe1')
emit('server:probe1', { pid: first.child.pid, api: first.api })
if (first.api) {
  // 端点文件只有 24 字节的普通文件：读出内容（可能是命名管道名或端口），并按内容去连。
  for (const name of ['herdr.sock', 'herdr-client.sock']) {
    const file = join(env.APPDATA, 'herdr', 'sessions', 'probe1', name)
    const raw = readFileSync(file)
    emit(`pointer:${name}`, { bytes: raw.length, utf8: raw.toString('utf8'), hex: raw.toString('hex') })
  }
  const pointer = readFileSync(first.api, 'utf8').trim()
  emit('connect-pointer:node', await pingPath(pointer))
  const pipes = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | Where-Object { $_ -match 'herdr|rovloom|probe' }"
    ],
    { encoding: 'utf8', timeout: 30_000 }
  )
  emit('pipes', {
    status: pipes.status,
    list: pipes.stdout?.trim().split(/\r?\n/u).slice(0, 50),
    stderr: pipes.stderr?.slice(0, 300)
  })
  for (const args of [
    ['api', 'ping'],
    ['workspace', 'list']
  ]) {
    const cli = spawnSync(exe, ['--session', 'probe1', ...args], { env, encoding: 'utf8', timeout: 20_000 })
    emit(`cli:${args.join(' ')}`, {
      status: cli.status,
      stdout: cli.stdout?.slice(0, 400),
      stderr: cli.stderr?.slice(0, 400)
    })
  }
  emit('dotnet:probe1', dotnetProbe(first.api, first.child.pid))
  emit('bun-connect:probe1', await bunConnect(first.api))
  const stat = statSync(first.api, { bigint: true })
  emit('stat:probe1', {
    ino: String(stat.ino),
    dev: String(stat.dev),
    mode: String(stat.mode),
    is_socket: stat.isSocket()
  })
}
const binary = statSync(exe, { bigint: true })
emit('exe-identity', { ino: String(binary.ino), dev: String(binary.dev), size: String(binary.size) })

// 2) bun:ffi 在 Windows 上能否调用 Win32（用于后续做对端校验）。
try {
  const { dlopen } = await import('bun:ffi')
  const kernel = dlopen('kernel32.dll', { GetCurrentProcessId: { args: [], returns: 'u32' } })
  emit('ffi', { ok: true, pid_matches: kernel.symbols.GetCurrentProcessId() === process.pid })
} catch (error) {
  emit('ffi', { ok: false, error: String(error?.message ?? error) })
}
first.child.kill()
await pause(1500)

// 3) HERDR_SOCKET_PATH 指向一个文件系统路径：server 是否改用它。
const custom = join(work, 'custom', 'api.sock')
mkdirSync(join(work, 'custom'), { recursive: true })
const second = await server('probe2', { HERDR_SOCKET_PATH: custom })
emit('server:probe2', { pid: second.child.pid, api: second.api, custom, custom_exists: existsSync(custom) })
if (existsSync(custom)) {
  emit('dotnet:probe2', dotnetProbe(custom, second.child.pid))
}
second.child.kill()
