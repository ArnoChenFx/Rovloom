# ADR 0003: Bun 1.4.3 development and execution baseline

Status: implemented locally for issue #15; parent acceptance and main alignment pending.
Date: 2026-10-18 UTC. Base: `4f963d1997751a4f392604cc060d0a99f157998a`.

Use official Bun 1.4.3 for installs, TypeScript execution, tests, P0 JavaScript
harnesses and Bun-targeted ESM builds. Keep the SDK 1.32.1 contract and all retained
dependency versions/integrities. Replace the npm lock with text `bun.lock` and
remove only tsx/esbuild and their optional platform dependencies. The independent
TypeScript 7.0.2 dispatcher runs explicitly through Bun, then its existing pinned
native TypeScript executable; no Node shebang fallback is needed. Do not equate
Bun transpilation or bundling with strict typechecking.

Keep the `node:sqlite` import: Bun supplies the implementation and the real-file,
memory, migration, recovery, rollback, bindings, BLOB paging and writer-lock tests
pass. `process.version` is a Node compatibility string, not evidence of a running
Node executable. Record Bun revision and `SELECT sqlite_version()` explicitly.

Build four existing module entrypoints to `dist/src/`, ESM, target Bun, packages
external, external source maps and shared chunks. Sharing is necessary to keep
`GatewayError` identity consistent across entrypoints. Clean old `dist` first.
No runnable Gateway/Connector entrypoint is invented. Declaration emission and a
Node-target artifact are not current deliverables.

Disable automatic `.env` loading in configuration and explicit workflow/child
arguments; no user env files or state directories enter verification. Disable
install lifecycle scripts; no trust-all or native-addon exception is needed.
Prove the workflow in a disposable project with empty dependency cache, minimal
environment, Node/npm/npx failure shims and Linux exec tracing. Platform proxy/CA
configuration may be inherited without credentials or logging its values.

Historical Node P0 evidence remains immutable. Store new Bun receipts separately.
The official release and observed revision, test commands and limits are in
[the report](../bun/REPORT.md). Linux success does not establish macOS/Windows,
commercial Host, OAuth or P1 transport correctness. Design v0.4 requirements are
unchanged and are not implemented by this runtime migration.
