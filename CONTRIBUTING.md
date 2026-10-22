# Contributing

Use Bun (the minimum version is in `package.json` `engines.bun`; CI runs the minimum and the latest).
Dependencies use `^` ranges; commit `bun.lock` with dependency changes. Project JavaScript and
TypeScript commands run through Bun.

Run the same gates as [CI](.github/workflows/bun.yml) from the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run build
bun run smoke
```

See [package.json](package.json) for individual commands. Maintain tests for the current behavior
and keep them in the suite run by `bun run test`; skips and disabled tests are not accepted.
Versioned protocol inputs live under `test/fixtures/`; keep their source/version proof and original bytes.
Runtime reports and collector output belong outside the checkout.
As part of each change, review added files and directories for a lasting responsibility:
group product modules, tools and tests by capability, and keep fixed protocol inputs
under their provider/version. Reuse existing entry points and checks. A new feature
directory is welcome when it has a distinct purpose; development phases and issue
numbers do not define permanent ownership. Remove one-off migration wrappers,
command logs and duplicate historical snapshots once their useful assertions have
maintained regression coverage. Document generators for retained derived inputs,
and keep native bytes, provenance and licenses needed by current regressions.
Comments are for readers: describe a module's responsibility, public interfaces, non-obvious
constraints and security decisions. Do not restate names, and keep execution logs out of code.

Keep English/Chinese README shell blocks and each architecture diagram synchronized.
Put worker logs, command output, handovers and per-run acceptance summaries in CI/PR evidence
or a temporary directory; keep versioned fixtures, provenance and maintained contracts in the repository.
