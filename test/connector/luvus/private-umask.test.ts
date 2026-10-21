import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { withPrivateUmask } from '../../../src/connector/luvus/local.js'

test('子进程在 077 umask 下创建，本进程 umask 随即还原', { skip: process.platform === 'win32' }, () => {
  const before = process.umask()
  const child = withPrivateUmask(() => spawnSync('/bin/sh', ['-c', 'umask'], { encoding: 'utf8' }))
  assert.equal(child.stdout.trim(), '0077')
  assert.equal(process.umask(), before)
})

test('派生失败时也还原 umask', { skip: process.platform === 'win32' }, () => {
  const before = process.umask()
  assert.throws(() =>
    withPrivateUmask(() => {
      throw new Error('spawn_failed')
    })
  )
  assert.equal(process.umask(), before)
})
