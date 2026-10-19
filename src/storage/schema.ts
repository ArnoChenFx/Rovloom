// 声明 v4 持久化表、唯一约束及过期索引；不提供对未发布旧版本的自动迁移。
export const SCHEMA_VERSION = 4
// 未发布的 v1/v2/v3 不在这里猜测来源或迁移；版本检查必须先于本 schema 的执行。
export const SCHEMA = `
CREATE TABLE metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
  generation TEXT NOT NULL, mode TEXT NOT NULL, clock INTEGER NOT NULL
);
CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, credential_hash TEXT, epoch TEXT, needs_confirmation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE enrollments (
  token_hash TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines,
  expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE providers (
  machine_id TEXT NOT NULL REFERENCES machines, provider_id TEXT NOT NULL,
  kind TEXT NOT NULL, config_ref TEXT NOT NULL, binding_revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL, PRIMARY KEY(machine_id,provider_id)
);
CREATE TABLE history (
  history_epoch TEXT PRIMARY KEY, recovery_generation TEXT NOT NULL,
  principal TEXT NOT NULL, machine_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL, status TEXT NOT NULL,
  scope_created_at INTEGER NOT NULL, accept_new_until INTEGER NOT NULL,
  frozen_dedup_ttl INTEGER NOT NULL
);
CREATE TABLE calls (
  call_id TEXT PRIMARY KEY, principal TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES machines,
  provider_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, provider_kind TEXT NOT NULL,
  request_hash TEXT NOT NULL, key_digest TEXT, history_epoch TEXT REFERENCES history,
  state TEXT NOT NULL, epoch TEXT, attempt_id TEXT, identity_json TEXT NOT NULL,
  binding_json TEXT, target_json TEXT NOT NULL, method TEXT NOT NULL,
  mode TEXT NOT NULL, request_json TEXT, response TEXT,
  created INTEGER NOT NULL, deadline INTEGER NOT NULL, content_expires INTEGER NOT NULL,
  metadata_expires INTEGER NOT NULL, dedup_expires INTEGER NOT NULL,
  content_status TEXT NOT NULL, response_hash TEXT, response_bytes INTEGER,
  response_category TEXT, reserved INTEGER NOT NULL DEFAULT 0,
  UNIQUE(history_epoch,key_digest)
);
CREATE INDEX calls_expiry ON calls(metadata_expires);
CREATE TABLE results (
  result_id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE REFERENCES calls ON DELETE CASCADE,
  bytes INTEGER NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE audit (
  event_id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL,
  call_id TEXT, at INTEGER NOT NULL, expires INTEGER NOT NULL, details TEXT NOT NULL
);
CREATE INDEX audit_expiry ON audit(expires);
CREATE TABLE backups (path TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE management (confirmation_id TEXT PRIMARY KEY, actor TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, fence TEXT NOT NULL);
`
