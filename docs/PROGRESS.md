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
- Schema version 3; transactional v1/v2 upgrades, unknown versions fail before DDL.
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

## Follow-up: authorized routing and durable context

The second local change adds `src/router.ts`, a transport-independent boundary
whose principal must be supplied by an authenticated transport, never tool input.
Create/read/dispatch/cancel check the current caller and connector-side policy.
No listener is exposed, and administrative Store primitives remain internal.

Schema version 2 adds target JSON, method and deadline without persisting request
payloads as a replay queue. Version 1 rows retain null context and are denied by
the Router, while direct internal ledger inspection remains possible. Unknown
versions are checked before DDL. The v1-to-v2 migration is transactional.

Acceptance is guarded by machine/call/attempt/epoch. Deadline sweeps and bridge
cancellation preserve not-dispatched versus unknown outcomes. The future runtime
must schedule `expire()`; no timer or remote cancellation is claimed here.
Canonical JSON now rejects cycles, sparse arrays, getters, symbols, non-JSON
objects, excessive depth/node count and content over 1 MiB.

Checks for this change: `npm run typecheck`, `npm test` (12 passed, 0 failed),
`npm run build`; supported Node 24 tests and staged whitespace check are rerun
before committing. New tests cover policy revocation on reads/dispatch/cancel,
durable context, acceptance fencing, deadline and cancellation semantics, JSON
bounds and unknown-version rejection without schema mutation.

## Follow-up: bounded result handles

The third change adds SQLite-backed result handles derived only from a call's
stored native response (callers cannot substitute arbitrary result content).
Reads recheck ownership, machine revocation and both current Router policies.
Byte cursors and base64 chunks preserve UTF-8 when boundaries split code points.
Metadata includes byte length, SHA-256 and expiry. Defaults: 64 KiB read pages,
one-hour TTL, 16 MiB aggregate result-payload quota. Expiry cleanup runs on writes
and `expire()`; revocation deletes the machine's result objects. Runtime scheduling
of cleanup is not implemented. Stored inline call responses remain outside this
result-object quota, so this is NOT a total database/disk quota.

Schema v3 adds result storage; real v1 fixtures now verify migration, legacy
Router rejection and unknown outcomes across reopen. The fourth change adds a populated v2-to-v3 regression fixture as well. Tests total 14, including byte-perfect multi-page reconstruction,
TTL, quotas, policy changes and cross-principal denial. Typecheck/build and Node 24
regression commands are rerun for this change.

## Follow-up: result lifecycle and migration regression

Fourth change: repeated `saveResult` for a live handle returns that handle without
allocating more payloads or extending expiry. Existing databases with duplicate
handles are not compacted automatically; they age out under their original TTL.
`discardResponse` rechecks Router policies and atomically removes handles plus the
inline response, keeping call metadata and request-key deduplication tombstones.
It is an internal primitive, not yet an MCP tool or scheduled retention job.

TTL remains a handle-lifetime rule: expiry alone does not delete `calls.response`,
and a new handle can be generated until explicit discard. Machine revocation
blocks access and deletes handles, but still does not erase inline responses.
Logical SQL deletion is not forensic/physical erasure, nor does it guarantee disk
space reclamation; backups and SQLite free pages may retain prior bytes.

New tests cover duplicate saves without TTL extension, aggregate payload quota
and expiry reclamation, invalid cursors/page sizes and EOF, reauthorized discard,
request-key tombstone preservation, populated v2 migration, persisted handles after
reopen and cleanup after expiry. Total: 17 tests. Commands: `npm run typecheck`,
`npm test`, `npm run build` pass on the host; Node 24 suite and staged whitespace
check rerun before committing. No native Luvus or remote-machine evidence is added.

## Follow-up: sixth-batch draft preserved for handover

On 2026-10-18 the user chose to hand development to another person. The interrupted
four-file change was independently inspected and saved as local source commit
`6cf59601d79c7be4855f024036d911fb11b54259`. Pi was stopped and the ten-minute
follow-up routine paused. See `docs/HANDOVER.md` for the takeover branch and gates.

`discardResponse` now additionally requires explicit
`principal.permissions.discard_response === true`, rather than deriving deletion
authority from read access. Its authenticated permission source is still pending.

`src/protocol.ts` is a draft 1.0 business-envelope codec, not a transport. It bounds
JSON and checks fields, correlation IDs, expected epoch and selected payload
shapes. It only accepts exact minor 0; capability negotiation is not implemented.
Native responses are only checked for result/error exclusivity, not the full
installed UHP schema (including required native id and detailed response shapes).
There is no authenticated socket binding, machine-target enforcement, replay
protection, deadline scheduler, handshake, streaming or Router/Store integration.
Do not treat the codec fixtures as P0 native conformance evidence.

Independent validation of this snapshot: typecheck and build passed; host Node
25.9.0 and Node 24.22.0 each passed 20 tests with 0 failures; staged whitespace
check passed. Dependencies were not reinstalled for this handover. Node 26 and
real two-machine end-to-end behavior remain unverified.

## Remaining gaps

P1 is partial: total database quotas, audit, rejection states,
approval and backup tooling are not implemented. Policy checks are wired through
an internal Router but not yet bound to an actual authenticated transport. A machine marked online
here represents a storage-level authenticated binding, not full connector readiness.
No full UHP request schema or response schema is validated yet. Canonicalization
limits individual JSON values to 1 MiB, while result handles have their own aggregate
payload quota and TTL. Inline call responses and ledger growth still lack aggregate
quotas/retention; transport framing and global disk limits remain required.
Tests simulate two device identities, not two physical machines. SQLite operations
are synchronous. Credential rotation, constant-time verification hardening,
Windows ACLs and runtime Node 26 testing remain pending. No production deployment
or full security certification is claimed.
