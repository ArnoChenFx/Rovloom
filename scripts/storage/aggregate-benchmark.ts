/** 多设备/双 provider 的磁盘聚合回放；只运行自有合成状态，不访问 native 或用户库。 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { auditRecord, type AuditCall } from '../../src/storage/audit.js'
import { assertBudget } from '../../src/storage/budget.js'
import { management, options } from '../../test/storage/helpers.js'
import type { V2Target } from '../../src/wire/types.js'

/** 固定样本数及分位算法；不把总事务耗时误报为 budget 自身。 */
function measure(run: () => void, count = 60) {
  const values: number[] = []
  for (let index = 0; index < count; index++) {
    const began = performance.now()
    run()
    values.push(performance.now() - began)
  }
  values.sort((a, b) => a - b)
  return { samples: count, p50_ms: values[Math.ceil(count * 0.5) - 1], p95_ms: values[Math.ceil(count * 0.95) - 1] }
}

/** 用正式登记/取消/派发入口建立三种合法行模板；批量回放仅用于避免 O(N²) 的准备成本。 */
function replay(store: Store, path: string, targets: V2Target[], epochs: Map<string, string>, count: number) {
  const templates: Record<string, unknown>[] = []
  for (let state = 0; state < 3; state++) {
    const call = store.createCall('benchmark', targets[0]!, { method: 'ping', params: {} }, options())
    if (state === 1) {
      store.stop('benchmark', call.call_id)
    } else if (state === 2) {
      store.dispatch('benchmark', call.call_id, epochs.get(targets[0]!.machine_id)!)
      store.stop('benchmark', call.call_id)
    }
    const reader = new DatabaseSync(path, { readOnly: true })
    templates.push({ ...reader.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id)! })
    reader.close()
  }
  const generation = store.generation()
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; DELETE FROM calls; DELETE FROM audit')
    const columns = Object.keys(templates[0]!)
    const insert = db.prepare(`INSERT INTO calls(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    const audit = db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)')
    for (let index = 0; index < count; index++) {
      const target = targets[index % targets.length]!
      const kind = target.provider_id
      // 18% 未派发、80% 明确未派发终态、2% unknown；unknown 继续持有收尾预约。
      const row = {
        ...templates[index % 50 === 0 ? 2 : index % 5 === 0 ? 0 : 1]!,
        call_id: 'history_' + index,
        machine_id: target.machine_id,
        provider_id: target.provider_id,
        provider_kind: kind,
        target_json: JSON.stringify(target),
        epoch: epochs.get(target.machine_id)!
      }
      for (const key of ['identity_json', 'binding_json']) {
        if (!row[key as keyof typeof row]) {
          continue
        }
        const identity = JSON.parse(String(row[key as keyof typeof row]))
        identity.call_id = row.call_id
        identity.target = target
        identity.provider_kind = kind
        if (key === 'binding_json') {
          identity.machine_id = target.machine_id
          identity.connection_epoch = row.epoch
        }
        Object.assign(row, { [key]: JSON.stringify(identity) })
      }
      insert.run(...columns.map((column) => row[column as keyof typeof row] as string | number | null))
      const actions =
        index % 50 === 0
          ? ['call_registered', 'call_dispatched', 'cancelled']
          : index % 5 === 0
            ? ['call_registered']
            : ['call_registered', 'cancelled']
      for (const [step, action] of actions.entries()) {
        const event = auditRecord(
          'audit_' + index + '_' + step,
          action,
          'benchmark',
          1_000_000,
          store.limits.metadata_ttl,
          generation,
          row as unknown as AuditCall
        )
        audit.run(event.event_id, event.action, event.actor, event.call_id, event.at, event.expires, event.details)
      }
    }
    db.exec('COMMIT')
    assert.equal(db.prepare('SELECT count(*) n FROM calls').get()!.n, count)
  } finally {
    db.close()
  }
}

/** 每个档位重建独立私有磁盘库；实际测量使用生产 Store 和 FULL 同步事务。 */
function benchmark(history: number) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-aggregate-'))
  const state = join(root, 'state')
  const backups = join(root, 'backups')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(backups, { mode: 0o700 })
  const path = join(state, 'gateway.db')
  let now = 1_000_000
  const store = new Store(path, () => now, { management, maintenanceIntervalMs: 60_000, backupDirectory: backups })
  const targets: V2Target[] = []
  const epochs = new Map<string, string>()
  const unsubscribe = store.subscribeInvalidation(() => {})
  try {
    for (let device = 0; device < 32; device++) {
      const machine = store.register('benchmark-' + device)
      const credential = store.redeem(store.issueEnrollment(machine.machine_id))
      epochs.set(machine.machine_id, store.connect(machine.machine_id, credential.credential))
      for (const kind of ['luvus', 'herdr'] as const) {
        store.defineProvider({
          machine_id: machine.machine_id,
          provider_id: kind,
          kind,
          config_ref: 'benchmark_' + kind,
          binding_revision: 1,
          enabled: true
        })
        targets.push({ machine_id: machine.machine_id, provider_id: kind, profile: 'session', session: 'benchmark' })
      }
    }
    // 历史增长前的两份真实快照；保持默认备份配额，避免把历史量提升等同于扩大配额。
    store.backup(join(backups, 'first.db'))
    store.backup(join(backups, 'second.db'))
    replay(store, path, targets, epochs, history)
    const db = new DatabaseSync(path)
    let budget
    let auditRows
    let databaseBytes
    try {
      auditRows = Number(db.prepare('SELECT count(*) n FROM audit').get()!.n)
      databaseBytes =
        Number(db.prepare('PRAGMA page_count').get()!.page_count) *
        Number(db.prepare('PRAGMA page_size').get()!.page_size)
      db.exec('BEGIN IMMEDIATE')
      budget = measure(() => assertBudget(db, path, store.limits, backups, true))
      db.exec('ROLLBACK')
    } finally {
      db.close()
    }
    let cursor = 0
    const registration = measure(() => {
      const target = targets[cursor++ % targets.length]!
      const call = store.createCall('benchmark', target, { method: 'ping', params: {} }, options())
      assert.equal(call.state, 'created')
    })
    const expiry = measure(() => store.expire(), 30)
    now += store.limits.metadata_ttl
    const began = performance.now()
    store.expire()
    const expiryBurstMs = performance.now() - began
    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(reader.prepare('SELECT count(*) n FROM calls').get()!.n, 0)
    } finally {
      reader.close()
    }
    return {
      history,
      devices: 32,
      providers: 64,
      audit_rows: auditRows,
      database_bytes: databaseBytes,
      budget,
      registration,
      expiry,
      expiry_burst_ms: expiryBurstMs
    }
  } finally {
    unsubscribe()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}
const counts = (process.argv[3] ?? '0,1000,10000,50000').split(',').map(Number)
assert(counts.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 50000))
const results = counts.map((count) => {
  const result = benchmark(count)
  process.stderr.write(JSON.stringify(result) + '\n')
  return result
})
const report = {
  runtime: process.version,
  bun: process.versions.bun,
  platform: process.platform,
  arch: process.arch,
  history_preparation: 'batched replay of production Store rows; no native/network',
  durability: 'file SQLite synchronous FULL',
  results
}
// stdout 或调用者指定的新文件只包含聚合计时，不包含路径、凭据或请求正文。
if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
} else {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}
