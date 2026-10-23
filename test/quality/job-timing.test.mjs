// Verify timing segments against fixed API fixtures; the report is evidence, so durations must be exact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { formatDuration, formatTimingReport, timingRows } from '../../scripts/ci/job-timing.mjs'

const script = fileURLToPath(new URL('../../scripts/ci/job-timing.mjs', import.meta.url))
const run = { created_at: '2026-10-23T00:00:00Z' }
const jobs = [
  {
    name: 'changes',
    conclusion: 'success',
    started_at: '2026-10-23T00:00:10Z',
    completed_at: '2026-10-23T00:00:40Z',
    steps: [
      { name: 'Set up job', started_at: '2026-10-23T00:00:10Z', completed_at: '2026-10-23T00:00:12Z' },
      { name: 'Run actions/checkout@v7', started_at: '2026-10-23T00:00:12Z', completed_at: '2026-10-23T00:00:32Z' },
      { name: 'Plan', started_at: '2026-10-23T00:00:32Z', completed_at: '2026-10-23T00:00:40Z' }
    ]
  },
  {
    name: 'quickstart (macos-15-intel, first-run)',
    conclusion: 'success',
    started_at: '2026-10-23T00:07:40Z',
    completed_at: '2026-10-23T00:20:00Z',
    steps: [
      {
        name: 'Upload artifact',
        started_at: '2026-10-23T00:19:00Z',
        completed_at: '2026-10-23T00:19:45Z'
      },
      {
        name: 'Quick Start on macOS',
        started_at: '2026-10-23T00:18:00Z',
        completed_at: null
      }
    ]
  },
  {
    name: 'luvus (macos-15, first-run)',
    conclusion: 'skipped',
    started_at: null,
    completed_at: null,
    steps: []
  },
  {
    name: 'macos acceptance',
    status: 'in_progress',
    conclusion: null,
    started_at: '2026-10-23T00:20:05Z',
    completed_at: null,
    steps: []
  }
]

test('formatDuration renders seconds, minutes and hours without padding noise', () => {
  assert.equal(formatDuration(null), '-')
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(60), '1m')
  assert.equal(formatDuration(125), '2m 5s')
  assert.equal(formatDuration(3600), '1h')
  assert.equal(formatDuration(3780), '1h 3m')
})

test('timingRows separates wait from run and picks the slowest completed step', () => {
  const rows = timingRows(run, jobs)
  assert.deepEqual(rows[0], {
    name: 'changes',
    conclusion: 'success',
    waitSeconds: 10,
    runSeconds: 30,
    slowestStep: { name: 'Run actions/checkout@v7', seconds: 20 }
  })
  // The unfinished step is ignored even though it started earliest; the upload segment stays visible.
  assert.deepEqual(rows[1].slowestStep, { name: 'Upload artifact', seconds: 45 })
  assert.equal(rows[1].waitSeconds, 460)
  assert.equal(rows[1].runSeconds, 740)
  // Skipped jobs have no segments; the still-running reporting job keeps its wait but no run total.
  assert.deepEqual(rows[2], {
    name: 'luvus (macos-15, first-run)',
    conclusion: 'skipped',
    waitSeconds: null,
    runSeconds: null,
    slowestStep: null
  })
  assert.equal(rows[3].conclusion, 'in_progress')
  assert.equal(rows[3].runSeconds, null)
})

test('formatTimingReport renders a summary table and the CLI tolerates the API envelope', () => {
  const report = formatTimingReport(run, jobs)
  assert.match(report, /\| changes \| success \| 10s \| 30s \| Run actions\/checkout@v7 \(20s\) \|/)
  assert.match(report, /\| luvus \(macos-15, first-run\) \| skipped \| - \| - \| - \|/)

  const root = mkdtempSync(join(tmpdir(), 'rovloom-job-timing-'))
  try {
    const jobsFile = join(root, 'jobs.json')
    const runFile = join(root, 'run.json')
    writeFileSync(jobsFile, JSON.stringify({ total_count: jobs.length, jobs }))
    writeFileSync(runFile, JSON.stringify(run))
    const result = spawnSync(process.execPath, ['--no-env-file', script, jobsFile, runFile], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /## Job timing/)
    // Missing input degrades to a note instead of failing the acceptance job.
    const broken = spawnSync(process.execPath, ['--no-env-file', script, join(root, 'missing.json'), runFile], {
      encoding: 'utf8'
    })
    assert.equal(broken.status, 0, broken.stderr)
    assert.match(broken.stdout, /Timing report unavailable/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
