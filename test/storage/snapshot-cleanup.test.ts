// 真实快照导出失败时只清理原目录中的产物，不跟随被替换的目录，也不覆盖主错误。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/store.js'
import { exportSnapshot } from '../../src/storage/backup.js'
import { management } from './helpers.js'

for (const replacement of ['link', 'directory', 'missing', 'unchanged'] as const) {
  test(`backup commit failure cleanup stays within the original directory: ${replacement}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-snapshot-cleanup-'))
    const state = join(root, 'state')
    const backups = join(root, 'backups')
    const moved = join(root, 'moved')
    const outside = join(root, 'outside')
    for (const path of [state, backups, outside]) {
      mkdirSync(path, { mode: 0o700 })
    }
    let armed = false
    const store = new Store(join(state, 'db'), () => 100, {
      management,
      backupDirectory: backups,
      fault(point) {
        if (armed && point === 'before_commit') {
          armed = false
          if (replacement !== 'unchanged') {
            renameSync(backups, moved)
            if (replacement === 'link') {
              symlinkSync(outside, backups, process.platform === 'win32' ? 'junction' : 'dir')
            } else if (replacement === 'directory') {
              mkdirSync(backups, { mode: 0o700 })
              for (const name of ['snapshot', 'snapshot.lock']) {
                writeFileSync(join(backups, name), 'replacement', { mode: 0o600 })
              }
            }
          }
          throw Object.assign(new Error('synthetic IO failure'), { code: 'EIO' })
        }
      }
    })
    try {
      for (const name of ['snapshot', 'snapshot.lock']) {
        writeFileSync(join(outside, name), 'outside', { mode: 0o600 })
      }
      armed = true
      assert.throws(() => store.backup(join(backups, 'snapshot')), /storage_degraded/)
      for (const name of ['snapshot', 'snapshot.lock']) {
        assert.equal(readFileSync(join(outside, name), 'utf8'), 'outside')
        if (replacement === 'directory') {
          assert.equal(readFileSync(join(backups, name), 'utf8'), 'replacement')
        }
        if (replacement !== 'unchanged') {
          assert(existsSync(join(moved, name)))
        } else {
          assert(!existsSync(join(backups, name)))
        }
      }
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('snapshot export failure cleanup does not follow a rebound directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-snapshot-export-'))
  const backups = join(root, 'backups')
  const outside = join(root, 'outside')
  for (const path of [backups, outside]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const store = new Store(':memory:', () => 100)
  const failure = new Error('synthetic source read failure')
  try {
    writeFileSync(join(outside, 'snapshot'), 'outside', { mode: 0o600 })
    // 输出数据库是真的 SQLite；只在读取源数据的固定位置模拟失败并替换目的目录。
    const source = {
      prepare() {
        renameSync(backups, join(root, 'moved'))
        symlinkSync(outside, backups, process.platform === 'win32' ? 'junction' : 'dir')
        throw failure
      }
    } as unknown as DatabaseSync
    assert.throws(
      () => exportSnapshot(source, join(backups, 'snapshot'), 100, store.limits),
      (error) => error === failure
    )
    assert.equal(readFileSync(join(outside, 'snapshot'), 'utf8'), 'outside')
    assert(existsSync(join(root, 'moved', 'snapshot')))
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
