# Contributing

Use Bun. CI uses the latest stable release. `package.json` keeps the minimum supported runtime in `engines.bun`.
Dependencies use `^` ranges; commit `bun.lock` with dependency changes. Run project JavaScript and TypeScript through Bun.

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

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the individual commands, build output, fixtures and browser checks.

## Guidelines

- Keep tests for current behavior in the suite run by `bun run test`. Skipped or disabled tests are not accepted.
- Versioned protocol inputs live under `test/fixtures/`. Keep their source and version proof and the original bytes.
- Group modules, tools and tests by lasting responsibility, not by development phase. Reuse existing entry points and checks. A new directory is welcome when it has a distinct purpose.
- Remove one-off migration wrappers, command logs and duplicate snapshots once maintained tests cover their assertions.
- Comments describe a module's responsibility, public interfaces, non-obvious constraints and security decisions. Do not restate names or include execution logs.
- Keep the English and Chinese README shell blocks and each architecture diagram in sync.
- Keep worker logs, command output and per-run acceptance summaries in CI/PR evidence or a temporary directory outside the checkout.
