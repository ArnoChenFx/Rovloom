// Summarize per-job timing segments of the current workflow run for the acceptance summary.
// Observability only: the report never decides acceptance, and malformed input yields a short note instead of an error.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function parseTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? null : time
}

function secondsBetween(start, end) {
  if (start === null || end === null) {
    return null
  }
  return Math.max(0, Math.round((end - start) / 1000))
}

/** Format whole seconds the way job summaries are scanned: 45s, 2m 5s, 1h 3m; missing data stays a dash. */
export function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) {
    return '-'
  }
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

function escapeCell(text) {
  return String(text).replaceAll('|', '\\|')
}

/**
 * Wait is run creation to job start (dependency wait plus runner assignment and cold start);
 * Run is job start to completion. Skipped jobs never start, and the reporting job is still
 * running when the report is generated, so both legitimately have missing segments.
 */
export function timingRows(run, jobs) {
  const created = parseTime(run?.created_at)
  return (jobs ?? []).map((job) => {
    const started = parseTime(job.started_at)
    let slowestStep = null
    for (const step of job.steps ?? []) {
      const duration = secondsBetween(parseTime(step.started_at), parseTime(step.completed_at))
      if (duration !== null && (slowestStep === null || duration > slowestStep.seconds)) {
        slowestStep = { name: step.name, seconds: duration }
      }
    }
    return {
      name: job.name ?? '-',
      conclusion: job.conclusion ?? job.status ?? '-',
      waitSeconds: secondsBetween(created, started),
      runSeconds: secondsBetween(started, parseTime(job.completed_at)),
      slowestStep
    }
  })
}

/** Render the Markdown table appended to the acceptance job summary. */
export function formatTimingReport(run, jobs) {
  const lines = [
    '## Job timing',
    '',
    '| Job | Result | Wait | Run | Slowest step |',
    '| --- | --- | ---: | ---: | --- |'
  ]
  for (const row of timingRows(run, jobs)) {
    const slowest =
      row.slowestStep === null
        ? '-'
        : `${escapeCell(row.slowestStep.name)} (${formatDuration(row.slowestStep.seconds)})`
    lines.push(
      `| ${escapeCell(row.name)} | ${escapeCell(row.conclusion)} | ${formatDuration(row.waitSeconds)} | ${formatDuration(row.runSeconds)} | ${slowest} |`
    )
  }
  lines.push(
    '',
    'Wait is measured from workflow run creation to job start, so it combines dependency wait, runner assignment and cold start. Run is job start to completion; the acceptance job itself is still running when this report is generated, so its Run segment is incomplete.'
  )
  return lines.join('\n') + '\n'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const jobsDocument = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    const run = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    const jobs = Array.isArray(jobsDocument) ? jobsDocument : jobsDocument.jobs
    process.stdout.write(formatTimingReport(run, jobs))
  } catch {
    // Timing is evidence for later decisions; a reporting failure must not mask the acceptance result.
    process.stdout.write('## Job timing\n\nTiming report unavailable.\n')
  }
}
