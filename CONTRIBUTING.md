# Contributing

Use the Bun version in [.bun-version](.bun-version). Keep the package/runtime
pins consistent and direct dependency versions exact; commit `bun.lock` with
dependency changes. Project JavaScript and TypeScript commands run through Bun.
Python 3 and Linux strace are also required for the complete verification.

Run the same gates as [CI](.github/workflows/bun.yml) from the repository root:

```sh
python3 -m unittest discover -s scripts/maintenance -p 'test_*.py' -v
python3 scripts/maintenance/check.py
python3 scripts/bun/verify.py --output /tmp/rovloom-verification-new
python3 scripts/maintenance/check.py --evidence /tmp/rovloom-verification-new
```

Choose a fresh output directory outside the checkout. The verifier performs a
frozen install, strict typechecking with negative probes, tests, fixture audits,
clean build and artifact smoke. See [package.json](package.json) for individual
commands. Preserve the original acceptance test inventory and
wire new suites into verification; every tracked `*.test.*`, `*_test.*`,
`*.spec.*` or `*_spec.*` JavaScript/TypeScript file must appear in its run evidence.
Code examples under `fixtures/` remain data.
Python `test_*.py` / `*_test.py` suites must have a verification command; flat
`scripts/maintenance/test_*.py` modules run through unittest discovery in CI.

Maintenance checks resolve rendered Markdown links/images against tracked files,
including reference/HTML links and Markdown heading or explicit anchors. Keep
English/Chinese README shell blocks and each architecture diagram synchronized.
External URLs are not fetched. Put worker logs, command output, handovers and
per-run acceptance summaries in CI/PR evidence or a temporary directory; keep
versioned fixtures, provenance and maintained contracts in the repository.
