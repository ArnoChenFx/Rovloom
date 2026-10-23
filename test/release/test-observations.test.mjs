/** 公开计时报告仅允许固定字段，不能把日志正文提升为诊断内容。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observations } from '../../scripts/ci/test-observations.mjs'

test('phase report ignores malformed/private data and retains slow and failed samples', () => {
  const base = {
    scope: 'rovloom-test-phase',
    phase: 'windows.scheduler.parse',
    platform: 'win32',
    arch: 'arm64',
    outcome: 'failed',
    elapsedMs: 36000
  }
  const log = [
    'private-secret',
    '{broken',
    JSON.stringify({ ...base, private: 'secret' }),
    JSON.stringify({ ...base, phase: 'private|injection' }),
    JSON.stringify({ ...base, elapsedMs: -1 })
  ].join('\n')
  assert.deepEqual(observations(log), [
    { phase: base.phase, platform: base.platform, arch: base.arch, outcome: base.outcome, elapsedMs: base.elapsedMs }
  ])
  assert(!JSON.stringify(observations(log)).includes('secret'))
})
