# Foundation Progress And Evidence

## Scope and decisions

This change implements a P1-oriented foundation only. It does not waive the P0
exit gates or claim the planned gateway is usable. The original v0.2 design and
implementation plan are unchanged.

- Work branch: `feat/core-contracts-ledger`.
- Clean clone: `luvus-mcp-implementation/`; previous uncommitted draft in
  `../luvus-mcp/` is untouched. Reuse decision: no code reused, since it has not
  passed the formal design's gates.
- Target runtime: Node 24 LTS; actual host Node 25.9.0 is outside the supported range.
- SQLite: built-in `node:sqlite`, avoiding a third-party native addon.
- Toolchain: TypeScript 7.0.2, tsx 4.23.15, @types/node 26.6.5, exact lockfile.
  Node type definitions being newer is not evidence of Node 26 runtime support.
- Names: NFKC, trimmed, lowercase ASCII `[a-z0-9._-]`, maximum 63 characters.
- Schema version 1, fail on unknown version; no upgrade path claimed yet.
- Exact policy allowlists; no read-only classification guessed from prefixes.
- Lockfile intentionally fails closed after a crash, requiring operator recovery.

## P0 read-only observations

Commands: `luvus --version`, `luvus help uhp`, `luvus uhp schema` (installed binary
`/home/boxuser/.local/bin/luvus`). Observed version 0.14.3. Schema parsed as JSON;
root keys: access, documents, event, event_catalog, protocol, request, response,
terminal. Raw bundle was written to a temporary file, not committed as a reviewed fixture.

No existing Luvus session was modified or inspected. No new session was started.
Live RPC/Host/events/terminal-control evidence, endpoint ownership validation,
platform matrix, MCP SDK choice and OAuth provider are still pending. These are
blockers for declaring P0 complete and for implementing unproven native adapters.

## Automated checks

- `npm install --package-lock-only`: completed, 0 vulnerabilities; EBADENGINE
  warning because host Node 25.9.0 is outside declared support.
- Initial `npm ls --depth=0`: failed ELSPROBLEMS due to mismatched manifest pins;
  corrected to installed exact versions, regenerated lockfile.
- Initial `npm run typecheck`: TS2565 (database initialization in constructor
  error handling); corrected definite assignment and rerun passed.
- `npm run typecheck`: passed, no diagnostics.
- `npm test`: 8 tests passed, 0 failed on Node 25.9.0.
- `npm run build`: passed, no diagnostics.
- `npx --yes --package=node@24 -c 'node --version; node --import tsx --test test/*.test.ts'`:
  Node 24.22.0, 8 passed, 0 failed.
- `npm ls --depth=0`: exact versions listed without invalid dependencies.
- `git diff --check`: passed, no whitespace errors (untracked additions are also
  reviewed through staged diff before commit).

Tests cover normalized names/ID stability, enrollment expiry/replay and sibling
invalidation, wrong/duplicate credentials, stale disconnect fencing, canonical
request-key conflicts, principal isolation, native error preservation, two-machine
response correlation, offline rejection, unknown outcomes/no replay, disk restart,
writer lock, POSIX file modes, absence of plaintext test credentials in SQLite,
reserved request fields, explicit targets and policy intersection.

## Remaining gaps

P1 is partial: result objects/quotas/TTL, audit, full transitions/deadlines,
approval, migration upgrades and backup tooling are not implemented. Policy checks
are pure functions, not yet bound to a transport principal. A machine marked online
here represents a storage-level authenticated binding, not full connector readiness.
No full UHP request schema or response schema is validated yet. No response size
limit is enforced in these internal primitives; transport must enforce it before use.
Tests simulate two device identities, not two physical machines. SQLite operations
are synchronous. Credential rotation, constant-time verification hardening,
Windows ACLs and runtime Node 26 testing remain pending. No production deployment
or full security certification is claimed.
