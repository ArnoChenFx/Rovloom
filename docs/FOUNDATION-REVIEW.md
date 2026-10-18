# Foundation review: 7ed9ef7

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
