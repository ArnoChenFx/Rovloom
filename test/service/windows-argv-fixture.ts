// 仅在自有云VM编译为参数探针，记录同版本Bun在Task Scheduler中的argv和标准句柄；不加载产品或配置。
import { renameSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'

declare const WINDOWS_ARGV_REPORT: string
const report: Record<string, unknown> = {
  phase: 'before_stdio',
  argv: process.argv,
  cwd: process.cwd(),
  executable: process.execPath,
  bun: process.versions.bun,
  platform: process.platform,
  arch: process.arch
}
writeFileSync(WINDOWS_ARGV_REPORT + '.phase', JSON.stringify(report), 'utf8')
try {
  report.account = userInfo().username
} catch {
  report.account = 'unavailable'
}
for (const stream of ['stdin', 'stdout', 'stderr'] as const) {
  try {
    const value = process[stream]
    report[stream] = { fd: value.fd, tty: !!value.isTTY }
  } catch {
    report[stream] = 'unavailable'
  }
}
try {
  process.stdout.write('argv_probe_stdout\n')
  process.stderr.write('argv_probe_stderr\n')
  report.write = 'completed'
} catch {
  report.write = 'failed'
}
report.phase = 'completed'
writeFileSync(WINDOWS_ARGV_REPORT + '.pending', JSON.stringify(report), 'utf8')
renameSync(WINDOWS_ARGV_REPORT + '.pending', WINDOWS_ARGV_REPORT)
