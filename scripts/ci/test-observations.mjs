/** 从既有测试输出提取固定计时字段；报告不参与验收，也不输出原始日志。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function observations(log) {
  const records = []
  for (const line of log.split('\n')) {
    if (!line.startsWith('{')) {
      continue
    }
    try {
      const row = JSON.parse(line)
      if (
        row.scope !== 'rovloom-test-phase' ||
        !/^[a-z0-9._-]{1,80}$/u.test(row.phase) ||
        !['completed', 'passed', 'failed'].includes(row.outcome) ||
        !Number.isSafeInteger(row.elapsedMs) ||
        row.elapsedMs < 0 ||
        !['linux', 'darwin', 'win32'].includes(row.platform) ||
        !['x64', 'arm64'].includes(row.arch)
      ) {
        continue
      }
      records.push({
        phase: row.phase,
        platform: row.platform,
        arch: row.arch,
        outcome: row.outcome,
        elapsedMs: row.elapsedMs
      })
      if (records.length === 256) {
        break
      }
    } catch {
      /* 非结构化测试输出不进入报告。 */
    }
  }
  return records
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let records = []
  try {
    records = observations(readFileSync(process.argv[2], 'utf8'))
  } catch {
    /* 早期失败没有日志时仍保留原门禁结论。 */
  }
  if (process.argv[3]) {
    writeFileSync(process.argv[3], JSON.stringify(records, null, 2) + '\n')
  }
  process.stdout.write('### Native test observations\n\n')
  if (!records.length) {
    process.stdout.write('No phase samples were recorded.\n')
  } else {
    process.stdout.write('| Phase | Platform | Outcome | Milliseconds |\n|---|---|---|---:|\n')
    for (const row of records) {
      process.stdout.write(`| ${row.phase} | ${row.platform}/${row.arch} | ${row.outcome} | ${row.elapsedMs} |\n`)
    }
  }
}
