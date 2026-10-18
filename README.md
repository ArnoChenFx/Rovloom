# luvus-mcp

A planned multi-machine Luvus MCP gateway and outbound connector, in one project.
The normative proposal is in [docs/DESIGN.md](docs/DESIGN.md) and
[docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md).

## Current status

Foundation only, not a runnable MCP server or connector. No public listener,
credentials, or services are installed. Existing unverified drafts outside this
checkout are not reused or modified.

Implemented:

- Explicit machine/profile/session targets and exact caller/local policy intersection.
- SQLite machine registry, normalized unique names, one-time enrollment and hashed device credentials.
- Duplicate-device rejection, connection epochs, revocation and principal-owned call records.
- Canonical request-key deduplication, response correlation and conservative restart/disconnect recovery.
- Single-writer lock and database file permissions on POSIX.
- Authorized Router and durable profile/session/method/deadline context.
- Deduplicated result handles with byte pagination, payload quota, TTL and revocation cleanup.
- Explicit response discard preserving call metadata and request-key tombstones, with a separate deletion permission.
- Draft versioned business-envelope codec and unit tests; not integrated with any transport.

Not implemented: WSS, MCP facade, UHP adapter/schema validation, credential rotation,
global database retention/quotas, streaming, HTTP OAuth, CLI, or deployment. Store methods are
internal primitives, not remotely accessible or independently authorized APIs.
Linux P0 native evidence is now available for review in
[docs/p0/REPORT.md](docs/p0/REPORT.md), with sanitized fixtures and a per-method
coverage ledger. This does not imply Gateway/Connector or P1 completion.

## Development

Target Node 24 LTS, with reproducible baseline 24.19.0 in `.node-version`.
Dependencies are pinned in `package-lock.json`. SQLite uses Node's built-in
`node:sqlite`. Node 26 and other platform combinations remain untested here.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:p0
npm run p0:audit
```

See [docs/PROGRESS.md](docs/PROGRESS.md) for evidence and limitations.
For the 2026-10-18 development handover, start with [docs/HANDOVER.md](docs/HANDOVER.md).
The current implementation is on `feat/reviewed-core-foundation` / Draft PR #1;
automated Pi development and follow-up are stopped. The draft codec does not yet
validate the full installed UHP schema or implement negotiated minor versions.
The local issue #3 task branch adds native evidence and
[ADR 0001](docs/adr/0001-p0-version-and-contract-baseline.md); the production
adapter is still absent. The installed schema has only generic parameter
objects for 144 methods, and the pinned MCP SDK negotiates 2025-11-25 rather
than the newer 2026-07-28 revision discussed in the design.

## Storage safety

The caller must supply a private state directory; database and lock files use
0600 on POSIX. There is no Windows ACL guarantee yet. Never publish enrollment
or device secrets in MCP content, logs or command arguments. Enrollment issuing
and redeeming are administrative primitives for a future protected channel.

A `.lock` file prevents concurrent writers. A crash intentionally leaves it in
place. An operator must confirm no writer is alive, back up the database, then
remove the stale lock before reopening. Never remove a live writer's lock.
Handle TTL does not delete inline call responses. Explicit response discard removes
logical response data and handles, not forensic copies, SQLite free pages or backups.
Automatic response retention and whole-database quotas are still pending.

Recovery marks machines offline and dispatched calls `outcome_unknown`; no
persisted request is automatically executed. Request-key deduplication is not an
exactly-once guarantee. This schema stores hashes, not queued request payloads.
