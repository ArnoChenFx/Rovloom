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
- Result handles with byte pagination, payload quota, TTL and revocation cleanup.

Not implemented: WSS, MCP facade, UHP adapter/schema validation, credential rotation,
global database retention/quotas, streaming, HTTP OAuth, CLI, or deployment. Store methods are
internal primitives, not remotely accessible or independently authorized APIs.
P0 live protocol gates remain open; this foundation does not imply P0/P1 completion.

## Development

Target Node 24 LTS (also permits Node 26 LTS). Dependencies are pinned in
`package-lock.json`. SQLite uses Node's built-in `node:sqlite`.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

See [docs/PROGRESS.md](docs/PROGRESS.md) for evidence and limitations.

## Storage safety

The caller must supply a private state directory; database and lock files use
0600 on POSIX. There is no Windows ACL guarantee yet. Never publish enrollment
or device secrets in MCP content, logs or command arguments. Enrollment issuing
and redeeming are administrative primitives for a future protected channel.

A `.lock` file prevents concurrent writers. A crash intentionally leaves it in
place. An operator must confirm no writer is alive, back up the database, then
remove the stale lock before reopening. Never remove a live writer's lock.
Recovery marks machines offline and dispatched calls `outcome_unknown`; no
persisted request is automatically executed. Request-key deduplication is not an
exactly-once guarantee. This schema stores hashes, not queued request payloads.
