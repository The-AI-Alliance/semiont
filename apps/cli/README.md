# @semiont/cli — deprecated

[![npm version](https://img.shields.io/npm/v/@semiont/cli.svg)](https://www.npmjs.com/package/@semiont/cli)
[![License](https://img.shields.io/npm/l/@semiont/cli.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

**This package no longer provides any commands.** It ships a single entry point that prints a
deprecation notice and exits.

## Use the launcher instead

The `semiont` launcher is a single static binary — no npm, no Node.js:

```bash
brew install the-ai-alliance/semiont/semiont
```

Then, from your knowledge-base directory:

```bash
semiont start        # bring the stack up
semiont status       # container state + per-service health
semiont logs         # follow service logs
semiont stop         # tear down
```

It also carries the knowledge-work verbs — `login`, `browse`, `gather`, `mark`, `match`, `bind`,
`listen`, `yield`, `beckon`. See [apps/launcher](../launcher/README.md).

## Where everything went

| Was | Now |
|---|---|
| `browse`, `gather`, `mark`, `match`, `bind`, `beckon`, `listen`, `yield`, `login` | the [launcher](../launcher/README.md) |
| `init`, `start`, `stop`, `clean` | the [launcher](../launcher/README.md) |
| `backup`, `restore`, `export`, `import` | backend endpoints under `/api/{admin,moderate}/exchange/*`, and the browser UI — see [Backup & Restore](../../docs/system/administration/BACKUP.md) and [Linked Data Exchange](../../docs/protocol/EXCHANGE.md) |
| `provision`, `check`, `watch`, `useradd`, `verify`, `publish`, `update`, `mv` | removed |
| programmatic access | [`@semiont/sdk`](../../packages/sdk/README.md) |

Deploying the container images (including on a cloud container platform) is covered by
[Deployment](../../docs/system/administration/DEPLOYMENT.md).

## Exit codes

`--version` and `--help` print the notice and exit `0`. Any other invocation exits `1`, so scripts
and container entrypoints fail loudly rather than continuing as though the work had happened.
