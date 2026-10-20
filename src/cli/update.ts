// 将唯一CLI接到现行只读更新检查；固定官方来源，不把下载或暂存当作替换成功。
import { handleUpdateCommand, UPDATE_HELP, type UpdateCommandHost } from '../update/command.js'
import { stableVersion } from '../update/version.js'
import { parseReleaseVersion } from '../release/contract.js'
import { PRODUCT_VERSION } from '../mcp/version.js'
import { UpdateError } from '../update/contract.js'

export type CliUpdateHost = Omit<UpdateCommandHost, 'write'>
const errors = new Set([
  'invalid_arguments',
  'invalid_current_version',
  'unsupported_platform',
  'network_failed',
  'request_timeout',
  'release_unavailable',
  'invalid_release',
  'invalid_manifest',
  'untrusted_redirect',
  'size_mismatch',
  'checksum_mismatch',
  'permission_denied',
  'unsafe_staging',
  'update_busy',
  'staging_failed',
  'staging_io_pending',
  'replacement_unavailable',
  'unsafe_installation',
  'target_changed',
  'candidate_unusable',
  'update_rolled_back',
  'update_recovery_required',
  'update_io_pending',
  'update_cleanup_failed',
  'update_failed'
])

// Linux只接受实际运行时报告的glibc版本；未知或musl不以固定true放行。
function runtimeLibc(): 'glibc' | null {
  if (process.platform !== 'linux') {
    return null
  }
  try {
    const report = process.report?.getReport()
    if (report && typeof report === 'object' && 'header' in report) {
      const header = report.header
      if (
        header &&
        typeof header === 'object' &&
        'glibcVersionRuntime' in header &&
        typeof header.glibcVersionRuntime === 'string' &&
        /^\d+\.\d+(?:\.\d+)?$/.test(header.glibcVersionRuntime)
      ) {
        return 'glibc'
      }
    }
  } catch {
    /* 不输出系统报告、环境或异常；未知运行时保持不支持。 */
  }
  return null
}

// stderr只允许固定错误码或经同一SemVer规则检查的非秘密版本状态。
function diagnostic(message: string): string {
  const error = /^update: ([a-z_]+)\n$/.exec(message)
  if (error && errors.has(error[1]!)) {
    return message
  }
  const status =
    message.length <= 256
      ? /^current=([^ ]+) target=([^ ]+) status=(available|up_to_date|newer_than_release)\n$/.exec(message)
      : null
  if (status && stableVersion(status[2])) {
    parseReleaseVersion(status[1]!)
    return message
  }
  const updated = message.length <= 128 ? /^status=updated version=([^ ]+)\n$/.exec(message) : null
  if (updated && stableVersion(updated[1])) {
    return message
  }
  throw new Error('invalid_update_output')
}

// 帮助完全离线；只有受信宿主明确提供现行POSIX事务时才允许替换。
export async function runUpdateCommand(
  args: readonly string[],
  write: (message: string) => void,
  host?: CliUpdateHost,
  signal?: AbortSignal
): Promise<number> {
  if (args.length === 2 && args[1] === '--help') {
    write(UPDATE_HELP)
    return 0
  }
  const trusted = host ?? {
    currentVersion: PRODUCT_VERSION,
    platform: process.platform,
    arch: process.arch,
    libc: runtimeLibc(),
    fetch: /* 只由现行更新模块构造固定官方URL，逐跳和字节预算仍使用其原实现。 */ (url: string, init: RequestInit) =>
      fetch(url, init)
  }
  const callerSignal = signal ? AbortSignal.any(trusted.signal ? [signal, trusted.signal] : [signal]) : trusted.signal
  const code = await handleUpdateCommand(args, {
    ...trusted,
    signal: callerSignal,
    fetch: /* 角色入口同样捕获进程信号；实际fetch必须收到CLI取消及原更新预算的共同signal。 */ (url, init) => {
      const requestSignal = callerSignal
        ? AbortSignal.any(init.signal ? [callerSignal, init.signal] : [callerSignal])
        : init.signal
      if (requestSignal?.aborted) {
        return Promise.reject(new UpdateError('network_failed'))
      }
      return trusted.fetch(url, { ...init, signal: requestSignal })
    },
    write: /* 重新检查运行时code/版本状态，未知宿主文本不能进入stderr。 */ (message) => write(diagnostic(message))
  })
  if (code === undefined) {
    throw new Error('invalid_update_command')
  }
  return code
}
