# Foundation reviews: 7ed9ef7, d1b8011 and 2e0b9cd

## Third batch: 2e0b9cd

Decision: suitable for another **draft** PR update, not deployment or P0/P1 completion. Source delta: five files, 179 additions and 6 deletions; local worktree clean. Remote baseline before publication: PR branch `09325e6`, main `afe1cb4`.

Independently reproduced: typecheck passed; build passed; 14 tests passed / 0 failed on host Node 25.9.0 and on Node 24.22.0; `git diff d1b8011..2e0b9cd --check` passed.

Reviewed additions:
- Result handles derive from the stored call response, with byte cursors/base64 chunks, SHA-256, expiry and aggregate handle-payload quota.
- Router result access rechecks principal ownership and caller/local policies; machine revocation deletes handle rows.
- A populated real-v1-schema migration and legacy Router fail-closed/reopen regression is now committed and passes.
- Progress text now distinguishes schema v3, per-value JSON bounds, result-handle quotas and missing total database retention.

Remaining gates / caveats:
- **TTL is handle availability, not source-response retention.** Inline `calls.response` remains readable through the internal call API and can create another handle after expiry; revocation removes handles and denies access but does not erase original response bytes. Do not advertise TTL/revocation as physical data erasure or all-data retention enforcement.
- Handle payload quota is not a global SQLite/disk quota. Repeated saveResult calls can create duplicate objects until quota is hit; any future idempotent/unique-per-call reuse policy must be explicit.
- Cleanup runs on writes/expire, not a scheduler; deletion is not secure erase or guaranteed disk reclamation.
- Explicit populated v2-to-v3 migration, exact aggregate-quota boundary/reclamation, cursor-at/end/after-end and restart preservation of result objects need dedicated regressions. Existing byte reconstruction/expiry/ownership tests pass but do not establish every edge case.
- First/second batch integration and P0 gates remain unless specifically resolved above. There is still no WSS/MCP/UHP transport or authenticated caller integration.

---

## Second batch: d1b8011

Decision: suitable for updating the existing **draft** PR. Not a production approval or P0/P1 completion. No implementation was modified by the reviewer.

Source: `d1b8011` on top of `7ed9ef7`; five changed paths (238 additions, 19 deletions). Remote PR branch was `4383b55` and main remained `afe1cb4` at review time.

Independent checks:
- `npm run typecheck`: passed.
- `npm test`: 12 passed, 0 failed on host Node 25.9.0.
- `npm run build`: passed.
- Node 24.22.0: 12 passed, 0 failed.
- `git diff 7ed9ef7..d1b8011 --check`: passed; worktree clean.
- Additional temporary v1 database fixture: migration to v2 passed; dispatched legacy call became `outcome_unknown`, preserved null routing context, Router rejected it with `legacy_call_context_unavailable`; reopening did not replay. This additional check was run independently and is not yet a committed regression test.

Resolved/partially resolved from the first review:
- Internal Router rechecks policies for create/read/dispatch/cancel; authenticated transport binding and administrative authorization remain future integration requirements.
- Profile/session target, method and deadline are persisted.
- Acceptance, cancellation and expiry primitives now exist. Expiry has no scheduler yet; callers must not assume wall-clock deadline causes an immediate state change without invoking it.
- JSON cycle/sparse-array/getter/depth/size checks were added. Network parsing and response schema validation remain required.
- v1-to-v2 migration and pre-DDL unknown-version rejection exist. Parent-directory security, backups and quotas still remain.

Follow-ups retained:
- Add the real v1 populated-database migration as a committed test; existing tests create v2 from fresh state and test unknown versions, but do not independently exercise a populated legacy fixture.
- `docs/PROGRESS.md` retains an old introductory statement saying schema version 1/no upgrade path, contradicted by the follow-up section. Its claim that no internal response-size limit exists is also stale now that `receive()` uses bounded canonicalization. Clarify aggregate result quotas/TTL versus per-value bounds.
- Do not claim a proxy/accessor-proof boundary for arbitrary in-process objects: Router snapshots normal JSON-compatible objects, but JavaScript Proxy traps are outside the network-JSON guarantee. Validate parsed input at the eventual transport.
- All remaining first-review gates not explicitly resolved above still apply, including live P0 evidence, WSS/MCP/UHP/streaming and deployment authentication.

---

# First batch review: 7ed9ef7

Date: 2026-10-18 (reviewed commit timestamp reference; local commands recorded in chat)
Reviewer: Luvus Tester
Scope: local commit `7ed9ef7e880714740a5241ce632e2164b3d58d5f` against remote `main` at `afe1cb43680d8f99f4145b88dd9056644a433095`.

## Decision

Suitable for a **draft foundation PR**, not approval for production deployment or completion of P0/P1. No changes were made to Pi's implementation during review. Do not merge or expose a listener merely because these tests pass.

The change adds nine files/changes (1,519 insertions). Formal `docs/DESIGN.md` and `docs/IMPLEMENTATION-PLAN.md` are unchanged. Tracked files do not include node_modules, generated dist output, local state databases or credentials.

## Independently reproduced checks

- Host Node v25.9.0: `npm run typecheck` passed; `npm test`: 8 passed, 0 failed; `npm run build` passed.
- Supported target Node v24.22.0 via `npx --yes --package=node@24 -c 'node --version; node --import tsx --test test/*.test.ts'`: 8 passed, 0 failed.
- `git diff afe1cb4..HEAD --check`: passed.
- Worktree was clean before/after the checks.
- `git fetch origin main`: remote baseline still `afe1cb43680d8f99f4145b88dd9056644a433095` at review time.
- Lockfile inspection: version 3, 53 package records, all resolved URLs under registry.npmjs.org; 2 records advertise installation scripts. This is a metadata inspection, not a dependency security audit, and no new `npm ci` was run during review.

## Code observations

- Enrollment and credentials are randomly generated and persisted as hashes, with expiry, one-time/sibling invalidation and revocation checks.
- Dispatch persists before delivery; disconnect/restart conservatively labels possibly sent calls `outcome_unknown`, with no automatic write replay in this storage layer.
- Response association checks machine, call, attempt and epoch. Tests cover cross-machine responses, stale disconnect/response, principal result isolation and exact error payload preservation.
- Runtime target/request checks and pure exact-allowlist authorization functions exist, but no transport binds identities or enforces them yet.
- Restart lock recovery intentionally requires manual intervention. Passing the reopen test does not demonstrate automatic crash recovery while a stale lock exists.

## Follow-up gates before integrating transport or calling P1 complete

1. **Authorization wiring:** `Store.createCall`, registration and administrative methods are internal unauthenticated primitives. The future facade/router must bind an authenticated principal and enforce caller/local policies on every relevant action and result read. Never expose Store methods directly.
2. **Durable context:** calls store machine and a target/request digest, not full profile/session/method/deadline metadata. This is deliberately not a replay queue, but routing provenance, audit and useful unknown-outcome diagnostics must be added before claiming the planned durable ledger is complete.
3. **State transitions:** `connector_accepted` is declared but has no transition API; deadline, cancellation, rejection and expiry transitions remain absent. Add guarded transitions and fault-injection tests alongside the router.
4. **Runtime JSON bounds:** current canonicalization assumes tree-shaped JSON. Cyclic or extremely deep in-process values can recurse to a RangeError; sparse arrays can produce ambiguous canonical output. Network input should be parsed/validated and bounded, and canonicalization should explicitly reject unsupported shapes before it becomes a general exported boundary.
5. **Persistent storage hardening:** private parent-directory handling, migration upgrades, backup, quotas/TTL and result storage are not implemented. Future migrations must verify existing metadata before mutating an unknown database version. POSIX chmod does not demonstrate Windows ACL support.
6. **Identity lifecycle:** rotation, protected enrollment delivery, constant-time credential comparison hardening, connection readiness vs storage-online state and takeover are still unimplemented.
7. **Runtime support claims:** tests independently cover Node 24 and host Node 25; Node 26 is permitted in package engines but not validated. The supported runtime statement should distinguish tested from merely permitted versions.
8. **P0 / remaining product:** live RPC/Host/event/terminal evidence, WSS, MCP facade, schema adaptation, streams, HTTP authentication, CLI and actual two-machine tests remain unverified/not implemented.

These are explicit integration/release gates, not claims that an exposed service is already vulnerable: this PR introduces no listener or CLI.

## Publication

Publish only these nine implementation paths, plus this review note, on an independent branch based on current main. Preserve v0.2 design documents and do not upload previous unreviewed draft code. GitHub plugin publication creates a new commit identity; the local `7ed9ef7` hash identifies reviewed source, not necessarily the remote commit hash.
