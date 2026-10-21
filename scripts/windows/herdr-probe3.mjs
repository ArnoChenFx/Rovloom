/** Windows 探测第三轮：验证用 bun:ffi 实现 Herdr 附着所需的 Win32 能力。
 * 端点是命名管道 `\\.\pipe\<sock 文件完整路径>`，sock 文件内容为 `<server pid>:<启动时间戳>`。
 * 只输出事实（JSON 行），不做断言。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { dlopen, read } from 'bun:ffi'

const emit = (key, value) =>
  console.log(
    JSON.stringify({ probe: key, ...(typeof value === 'object' ? value : { value }) }, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v
    )
  )
const root = process.argv[2]
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
const work = join(tmpdir(), 'rovloom-herdr-probe3')
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

/** UTF-16LE、NUL 结尾的缓冲区，供 *W 系列 API 使用。 */
const wide = (text) => Buffer.from(text + '\0', 'utf16le')
/** 读 NUL 结尾的 UTF-16 字符串。 */
function readWide(pointer) {
  const units = []
  for (let offset = 0; offset < 4096; offset += 2) {
    const unit = read.u16(pointer, offset)
    if (unit === 0) {
      break
    }
    units.push(unit)
  }
  return String.fromCharCode(...units)
}

const k32 = dlopen('kernel32.dll', {
  CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
  CloseHandle: { args: ['u64'], returns: 'i32' },
  GetLastError: { args: [], returns: 'u32' },
  GetNamedPipeServerProcessId: { args: ['u64', 'ptr'], returns: 'i32' },
  OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'u64' },
  QueryFullProcessImageNameW: { args: ['u64', 'u32', 'ptr', 'ptr'], returns: 'i32' },
  GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  GetCurrentProcess: { args: [], returns: 'u64' },
  LocalFree: { args: ['u64'], returns: 'u64' }
})
const adv = dlopen('advapi32.dll', {
  GetNamedSecurityInfoW: { args: ['ptr', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'u32' },
  ConvertSidToStringSidW: { args: ['u64', 'ptr'], returns: 'i32' },
  OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'i32' },
  GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'i32' }
})
const INVALID = 0xffffffffffffffffn

/** 管道服务端 pid：打开客户端句柄后由内核回答，不依赖任何文件内容。 */
function pipeServerPid(pipePath) {
  const handle = k32.symbols.CreateFileW(wide(pipePath), 0xc0000000, 0, null, 3, 0, 0n)
  if (handle === INVALID) {
    return { error: 'CreateFileW', code: k32.symbols.GetLastError() }
  }
  try {
    const out = Buffer.alloc(4)
    return k32.symbols.GetNamedPipeServerProcessId(handle, out)
      ? { pid: out.readUInt32LE(0) }
      : { error: 'GetNamedPipeServerProcessId', code: k32.symbols.GetLastError() }
  } finally {
    k32.symbols.CloseHandle(handle)
  }
}

/** 进程镜像路径与创建时间（FILETIME，100ns，自 1601）。 */
function processFacts(pid) {
  const handle = k32.symbols.OpenProcess(0x1000, 0, pid) // PROCESS_QUERY_LIMITED_INFORMATION
  if (!handle) {
    return { error: 'OpenProcess', code: k32.symbols.GetLastError() }
  }
  try {
    const path = Buffer.alloc(2 * 1024)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(1024, 0)
    const gotPath = k32.symbols.QueryFullProcessImageNameW(handle, 0, path, size)
    const image = gotPath ? path.toString('utf16le', 0, size.readUInt32LE(0) * 2) : undefined
    const times = Buffer.alloc(32)
    const gotTimes = k32.symbols.GetProcessTimes(
      handle,
      times.subarray(0, 8),
      times.subarray(8, 16),
      times.subarray(16, 24),
      times.subarray(24, 32)
    )
    return { image, creation_filetime: gotTimes ? String(times.readBigUInt64LE(0)) : undefined }
  } finally {
    k32.symbols.CloseHandle(handle)
  }
}

/** 文件属主 SID 与当前进程用户 SID。 */
function ownerSid(path) {
  const owner = Buffer.alloc(8)
  const descriptor = Buffer.alloc(8)
  const status = adv.symbols.GetNamedSecurityInfoW(wide(path), 1, 1, owner, null, null, null, descriptor)
  if (status !== 0) {
    return { error: 'GetNamedSecurityInfoW', code: status }
  }
  const sidPointer = owner.readBigUInt64LE(0)
  const out = Buffer.alloc(8)
  adv.symbols.ConvertSidToStringSidW(sidPointer, out)
  const sid = readWide(Number(out.readBigUInt64LE(0)))
  k32.symbols.LocalFree(descriptor.readBigUInt64LE(0))
  return { sid }
}
function currentUserSid() {
  const token = Buffer.alloc(8)
  if (!adv.symbols.OpenProcessToken(k32.symbols.GetCurrentProcess(), 8, token)) {
    return { error: 'OpenProcessToken', code: k32.symbols.GetLastError() }
  }
  const handle = token.readBigUInt64LE(0)
  const buffer = Buffer.alloc(512)
  const length = Buffer.alloc(4)
  if (!adv.symbols.GetTokenInformation(handle, 1, buffer, 512, length)) {
    k32.symbols.CloseHandle(handle)
    return { error: 'GetTokenInformation', code: k32.symbols.GetLastError() }
  }
  const out = Buffer.alloc(8)
  adv.symbols.ConvertSidToStringSidW(buffer.readBigUInt64LE(0), out)
  k32.symbols.CloseHandle(handle)
  return { sid: readWide(Number(out.readBigUInt64LE(0))) }
}

/** node:net 连管道并 ping。 */
function ping(pipePath) {
  return new Promise((resolve) => {
    let data = ''
    const socket = connect(pipePath)
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

const child = spawn(exe, ['--session', 'probe1', 'server'], { env, stdio: 'ignore', windowsHide: true })
await pause(4000)
const sock = join(env.APPDATA, 'herdr', 'sessions', 'probe1', 'herdr.sock')
const client = join(env.APPDATA, 'herdr', 'sessions', 'probe1', 'herdr-client.sock')
const pipe = '\\\\.\\pipe\\' + sock
emit('server', { pid: child.pid, sock, pipe, pointer: readFileSync(sock, 'utf8') })
emit('ping:api-pipe', await ping(pipe))
emit('pipe-server-pid:api', { ...pipeServerPid(pipe), expected: child.pid })
emit('pipe-server-pid:client', { ...pipeServerPid('\\\\.\\pipe\\' + client), expected: child.pid })
emit('process-facts', { ...processFacts(child.pid), expected_image: exe })
emit('exe-stat', { ino: String(statSync(exe, { bigint: true }).ino) })
emit('owner-sid:sock', ownerSid(sock))
emit('owner-sid:exe', ownerSid(exe))
emit('current-user-sid', currentUserSid())
const identity = spawnSync(
  'pwsh',
  ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
  { encoding: 'utf8' }
)
emit('current-user-sid:dotnet', identity.stdout?.trim())
// 管道自身的 DACL 无法直接读取；记录我们是否能以同一用户打开，作为最小事实。
emit('pipe-exists', { exists: existsSync(pipe) })
child.kill()
await pause(1500)
emit('after-kill', { ping: await ping(pipe), pipe_server_pid: pipeServerPid(pipe) })
