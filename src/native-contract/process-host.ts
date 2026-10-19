// Linux x64/glibc 私有进程宿主：同步、有界 IPC 与内核强终止，不依赖 Bun Worker 软限制。
import { dlopen, ptr, read, FFIType } from 'bun:ffi'
import { closeSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { ContractFault, fail } from './json.js'

export const COMPILER_HEAP_BYTES = 64 * 1024 * 1024
export const COMPILER_DEADLINE_MS = 2000
export type CompilerMetrics = Readonly<{
  heap_limit_bytes: number
  deadline_ms: number
  address_space_limit_bytes: number
  spawn_peak_rss_bytes: number
  exit: number
}>
const SOURCE_HASH = 'a4e2341eee0cb98e40942fbaad9668de0bad96d6bd07c642aedd03681f669423'
const MAX_FRAME = 8 * 1024 * 1024
const MAX_REPLY = 1024 * 1024
const running = new Set<SchemaProcess>()
// 正常退出同步释放；异常死亡另由子进程 PDEATHSIG 兜底，不注册新的权限或持久状态。
process.once(
  'exit',
  /* 同步终止仍存活的编译子进程。 */ () => {
    for (const entry of running) {
      entry.stop()
    }
  }
)

// 只在明确支持的平台加载 libc；缺少所需原语时失败关闭，不尝试较弱宿主。
function nativeLibrary() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail('schema_unavailable', 'isolation', 'unsupported_platform')
  }
  return dlopen('libc.so.6', {
    socketpair: { args: ['i32', 'i32', 'i32', 'ptr'], returns: 'i32' },
    posix_spawn_file_actions_init: { args: ['ptr'], returns: 'i32' },
    posix_spawn_file_actions_destroy: { args: ['ptr'], returns: 'i32' },
    posix_spawn_file_actions_adddup2: { args: ['ptr', 'i32', 'i32'], returns: 'i32' },
    posix_spawn_file_actions_addopen: { args: ['ptr', 'i32', 'ptr', 'i32', 'u32'], returns: 'i32' },
    posix_spawn_file_actions_addclosefrom_np: { args: ['ptr', 'i32'], returns: 'i32' },
    posix_spawn: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
    send: { args: ['i32', 'ptr', 'u64', 'i32'], returns: FFIType.i64_fast },
    recv: { args: ['i32', 'ptr', 'u64', 'i32'], returns: FFIType.i64_fast },
    poll: { args: ['ptr', 'u64', 'i32'], returns: 'i32' },
    kill: { args: ['i32', 'i32'], returns: 'i32' },
    wait4: { args: ['i32', 'ptr', 'i32', 'ptr'], returns: 'i32' },
    __errno_location: { args: [], returns: 'ptr' }
  })
}
let native: ReturnType<typeof nativeLibrary> | undefined

// 库实例只持有函数地址，不存放请求、凭据或 schema。
function libc() {
  try {
    return (native ??= nativeLibrary()).symbols
  } catch (error) {
    if (error instanceof ContractFault) {
      throw error
    }
    fail('schema_unavailable', 'isolation', 'unsupported_platform')
  }
}

// 为 posix_spawn 生成空终止的 argv/env 指针表；所有 Buffer 在调用期间保持存活。
function strings(values: string[]) {
  const buffers = values.map(/* 为每个参数保留空终止字节串。 */ (value) => Buffer.from(value + '\0'))
  const table = Buffer.alloc(8 * (values.length + 1))
  buffers.forEach(
    /* 按 Linux x64 指针宽度写入地址表。 */ (value, index) => table.writeBigUInt64LE(BigInt(ptr(value)), index * 8)
  )
  return { buffers, table }
}

// 固定构建来源和产物摘要必须匹配；本地构建记录不是消息可自证的契约来源。
function verifyAssets(directory: string): string {
  try {
    const manifestPath = resolve(directory, 'manifest.json')
    if (statSync(manifestPath).size > 8192) {
      fail('schema_unavailable', 'isolation', 'invalid_compiler_assets')
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const executable = resolve(directory, 'schema-worker')
    const stat = statSync(executable)
    if (
      !stat.isFile() ||
      stat.size > 8 * 1024 * 1024 ||
      (stat.mode & 0o022) !== 0 ||
      manifest.compiler_protocol !== 1 ||
      manifest.platform !== 'linux' ||
      manifest.arch !== 'x64' ||
      manifest.heap_bytes !== COMPILER_HEAP_BYTES ||
      manifest.deadline_ms !== COMPILER_DEADLINE_MS ||
      manifest.quickjs_source_sha256 !== SOURCE_HASH ||
      createHash('sha256').update(readFileSync(executable)).digest('hex') !== manifest.binary_sha256
    ) {
      fail('schema_unavailable', 'isolation', 'invalid_compiler_assets')
    }
    return executable
  } catch (error) {
    if (error instanceof ContractFault) {
      throw error
    }
    fail('schema_unavailable', 'isolation', 'invalid_compiler_assets')
  }
}

// 进程失败时统一清理；信号不能转成原生 payload 或可继续使用的校验结果。
export class SchemaProcess {
  #fd = -1
  #pid = 0
  #sequence = 0
  #busy = false
  #metrics: CompilerMetrics | undefined

  // 通过 posix_spawn 只继承专用 socket 和丢弃 stderr，不继承宿主其它文件描述符或环境。
  constructor(directory: string) {
    const lib = libc()
    for (const entry of running) {
      entry.active()
    }
    if (running.size >= 4) {
      fail('schema_unavailable', 'isolation', 'compiler_capacity')
    }
    const executable = verifyAssets(directory)
    const path = Buffer.from(executable + '\0')
    const argv = strings([executable, String(process.pid)])
    const env = strings(['LANG=C.UTF-8'])
    const pair = Buffer.alloc(8)
    if (lib.socketpair(1, 1 | 0x80000 | 0x800, 0, ptr(pair))) {
      fail('schema_unavailable', 'isolation', 'compiler_start_failed')
    }
    const parent = pair.readInt32LE(0)
    const child = pair.readInt32LE(4)
    const actions = Buffer.alloc(256)
    let initialized = false
    try {
      if (lib.posix_spawn_file_actions_init(ptr(actions))) {
        throw Error('spawn')
      }
      initialized = true
      const devNull = Buffer.from('/dev/null\0')
      if (
        lib.posix_spawn_file_actions_adddup2(ptr(actions), child, 0) ||
        lib.posix_spawn_file_actions_adddup2(ptr(actions), child, 1) ||
        lib.posix_spawn_file_actions_addopen(ptr(actions), 2, ptr(devNull), 1, 0) ||
        lib.posix_spawn_file_actions_addclosefrom_np(ptr(actions), 3)
      ) {
        throw Error('spawn')
      }
      const pid = Buffer.alloc(4)
      if (lib.posix_spawn(ptr(pid), ptr(path), ptr(actions), null, ptr(argv.table), ptr(env.table))) {
        throw Error('spawn')
      }
      this.#fd = parent
      this.#pid = pid.readInt32LE(0)
      running.add(this)
    } catch {
      closeSync(parent)
      fail('schema_unavailable', 'isolation', 'compiler_start_failed')
    } finally {
      if (initialized) {
        lib.posix_spawn_file_actions_destroy(ptr(actions))
      }
      closeSync(child)
      // 明确保留字符串缓冲到 spawn 完成，避免指针表成为悬空引用。
      void argv.buffers
      void env.buffers
    }
  }

  // 观测并回收已退出的进程；不从相同 PID、摘要或新进程恢复旧身份。
  active(): boolean {
    if (!this.#pid) {
      return false
    }
    this.#reap(1)
    return this.#pid !== 0
  }

  // 仅供宿主观测自建进程的内核限制，不进入契约或原生来源证明。
  processId(): number {
    return this.#pid
  }

  // wait4 的 RSS 包含 posix_spawn 在 exec 前继承的 Bun 页；不能作为 VM 峰值或预算证明。
  #reap(options: number): void {
    if (!this.#pid) {
      return
    }
    const status = Buffer.alloc(4)
    const usage = Buffer.alloc(144)
    const lib = libc()
    let result: number
    do {
      result = lib.wait4(this.#pid, ptr(status), options, ptr(usage))
    } while (result === -1 && read.i32(lib.__errno_location()!) === 4)
    if (result === 0) {
      return
    }
    const state = status.readInt32LE(0)
    this.#metrics = Object.freeze({
      heap_limit_bytes: COMPILER_HEAP_BYTES,
      deadline_ms: COMPILER_DEADLINE_MS,
      address_space_limit_bytes: COMPILER_HEAP_BYTES,
      spawn_peak_rss_bytes: result > 0 ? Number(usage.readBigInt64LE(32)) * 1024 : 0,
      exit: result > 0 ? (state & 127 ? -(state & 127) : (state >> 8) & 255) : -1
    })
    this.#pid = 0
    running.delete(this)
    if (this.#fd >= 0) {
      closeSync(this.#fd)
      this.#fd = -1
    }
  }

  // 原生处理器先 SIGKILL 并 wait 回收校验子进程再 _exit；JS 无法捕获，宿主同步回收父进程。
  stop(): CompilerMetrics {
    if (this.#pid) {
      libc().kill(this.#pid, 10)
      this.#reap(0)
    }
    return (
      this.#metrics ??
      Object.freeze({
        heap_limit_bytes: COMPILER_HEAP_BYTES,
        deadline_ms: COMPILER_DEADLINE_MS,
        address_space_limit_bytes: COMPILER_HEAP_BYTES,
        spawn_peak_rss_bytes: 0,
        exit: -1
      })
    )
  }

  // poll 的绝对截止覆盖写入和读取，不能通过持续小块进度续期。
  #ready(events: number, until: number): void {
    const poll = Buffer.alloc(8)
    poll.writeInt32LE(this.#fd, 0)
    poll.writeInt16LE(events, 4)
    for (;;) {
      const remaining = Math.ceil(until - performance.now())
      if (remaining <= 0) {
        fail('schema_unavailable', 'isolation', 'compiler_timeout')
      }
      const result = libc().poll(ptr(poll), 1, remaining)
      if (result === 0) {
        fail('schema_unavailable', 'isolation', 'compiler_timeout')
      }
      if (result < 0) {
        if (read.i32(libc().__errno_location()!) === 4) {
          continue
        }
        fail('schema_unavailable', 'isolation', 'compiler_failed')
      }
      if (poll.readInt16LE(6) & (events | 8 | 16 | 32)) {
        return
      }
    }
  }

  // 非阻塞 socket 在内核 readiness 后分段传输，截断或异常直接失效整个进程。
  #transfer(buffer: Buffer, sending: boolean, until: number): void {
    let offset = 0
    while (offset < buffer.length) {
      this.#ready(sending ? 4 : 1, until)
      const address = ptr(buffer, offset)
      const count = Number(
        sending
          ? libc().send(this.#fd, address, buffer.length - offset, 0x4000 | 0x40)
          : libc().recv(this.#fd, address, buffer.length - offset, 0x40)
      )
      if (count < 0 && [4, 11].includes(read.i32(libc().__errno_location()!))) {
        continue
      }
      if (count <= 0) {
        fail('schema_unavailable', 'isolation', 'compiler_failed')
      }
      offset += count
    }
  }

  // 私有协议只接受准确版本和序号；任何协议/执行错误都不可产生后续许可。
  request(op: string, payload: Record<string, unknown>, initialDeadline?: number): unknown {
    if (this.#busy || !this.active()) {
      fail('schema_unavailable', 'isolation', 'compiler_unavailable')
    }
    this.#busy = true
    let frame: Buffer | undefined
    try {
      const sequence = this.#sequence++
      if (!Number.isSafeInteger(sequence)) {
        fail('schema_unavailable', 'isolation', 'compiler_protocol_invalid')
      }
      frame = Buffer.from(JSON.stringify({ compiler_protocol: 1, sequence, op, ...payload }))
      if (!frame.length || frame.length > MAX_FRAME) {
        fail('schema_unavailable', 'isolation', 'compiler_frame_limit')
      }
      const header = Buffer.alloc(4)
      header.writeUInt32BE(frame.length)
      const until = initialDeadline ?? performance.now() + COMPILER_DEADLINE_MS
      this.#transfer(header, true, until)
      this.#transfer(frame, true, until)
      this.#transfer(header, false, until)
      const size = header.readUInt32BE(0)
      if (!size || size > MAX_REPLY) {
        fail('schema_unavailable', 'isolation', 'compiler_frame_limit')
      }
      const reply = Buffer.alloc(size)
      this.#transfer(reply, false, until)
      const message = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(reply))
      const expected = ['compiler_protocol', 'sequence', 'ok', message?.ok === true ? 'value' : 'error']
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        Object.keys(message).length !== expected.length ||
        expected.some(/* 拒绝缺省或额外的私有 IPC 字段。 */ (key) => !Object.hasOwn(message, key)) ||
        message.compiler_protocol !== 1 ||
        message.sequence !== sequence ||
        typeof message.ok !== 'boolean'
      ) {
        fail('schema_unavailable', 'isolation', 'compiler_protocol_invalid')
      }
      if (message.ok !== true) {
        const reason = message.error?.reason
        fail(
          'schema_unavailable',
          'compile',
          typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'compiler_failed'
        )
      }
      return message.value
    } catch (error) {
      const metrics = this.stop()
      if (metrics.exit === -14 || metrics.exit === 142) {
        fail('schema_unavailable', 'isolation', 'compiler_timeout')
      }
      if (error instanceof ContractFault) {
        throw error
      }
      fail('schema_unavailable', 'isolation', 'compiler_protocol_invalid')
    } finally {
      frame?.fill(0)
      this.#busy = false
    }
  }
}
