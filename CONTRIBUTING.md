# Contributing

Report bugs and request features as issues in this repository. Discuss bigger changes there before writing a PR.
Report security bugs by email instead: see [SECURITY.md](SECURITY.md). Keep PRs small, one mod per PR where you can,
and add tests for logic changes.

## Setup

You need the Lumbridge app (`lumbridge-app` on PATH), Node.js 18 or newer, Python 3 and rsync.

## Checks

```sh
scripts/ci.sh                               # what to run before a PR: check.sh, then tests/*.test.mjs
LUMBRIDGE_MODS_NO_APP=1 scripts/ci.sh       # without the app: syntax only instead of lumbridge-app check
```

`scripts/check.sh` checks names, JSON, the kit copies and runs `lumbridge-app check` on each mod, which loads it and
renders its first state. That is not enough on its own: install the mod and look at it in a window too.

Keep the logic a mod can test without a window in its `logic.js`, and test it in `tests/<mod>-logic.test.mjs` (plain
Node, `node:assert`). `tests/fixtures/` holds made-up data only.

Shared code goes in `lib/kit.js`; run `scripts/sync-kit.sh` after changing it and commit the copies.

Before a PR, run `scripts/scrub-check`. It fails on private network addresses, home folders, email addresses and
token formats that are not listed in `.scrub-allow`. Use made-up examples: user `sam`, host `desk`, `example.com`,
`192.0.2.x`.

PRs target `main`. Write what users will notice in CHANGELOG.md. By sending a PR you agree that your change is
licensed under Apache-2.0, like the rest of the project.
