# semiont launcher

A host-installed CLI that runs a local Semiont stack — Neo4j, Qdrant, Ollama,
PostgreSQL, the Semiont API server, worker, smelter, weaver, and the frontend —
by driving your container runtime (Apple `container`, Docker, or Podman)
directly. It replaces the `.semiont/scripts/{start,logs,stop}.sh` trio that
used to be synced into every KB repository; the design record is
`.plans/GO-LAUNCHER.md` in this monorepo.

## Install

```sh
brew install the-ai-alliance/semiont/semiont
```

macOS and Linux (and Windows via WSL2), arm64 and amd64. The binary is static:
no language runtime bleeds onto your host. Besides the launcher you need only
`git` and one container runtime (`container`, `docker`, or `podman`) on PATH.

## Use

Run from inside a KB clone:

```sh
semiont start --email admin@example.com --password mypassword
semiont status
semiont logs
semiont stop
```

- `semiont start --help` lists all flags (`--config`, `--runtime`,
  `--no-observe`, `--force-kill-ports`, `--ollama-cache`, …).
- `semiont start --dry-run` prints the exact runtime commands a real run would
  execute — the legibility answer to "what does this binary actually do".
- `semiont status` reports, per service, the container state as the runtime
  sees it and an application-level health probe (exit 0 only when every core
  service is healthy — scriptable).
- `semiont stop` sweeps **every** installed runtime by default, so a stack
  started under `--runtime docker` can't survive a plain stop.
- `semiont about` shows what Semiont is, project links, the image registry,
  and which runtimes were detected on PATH.
- Every invocation is logged (invoke + exit lines, with `--password` values
  redacted) to `launcher.log` in the launcher's log home: `~/Library/Logs/
  semiont` on macOS, `$XDG_STATE_HOME/semiont` (default
  `~/.local/state/semiont`) on Linux. `semiont status` lists the dir under
  LOCAL HOST DIRECTORIES. Logging is best-effort — it never blocks a command.
- `start` records what it believes the stack IS — the runtime, and each
  service's container name, runtime-reported ID, and image — in `stack.json`
  in the launcher's state home (`~/Library/Application Support/semiont` on
  macOS, `$XDG_STATE_HOME/semiont` on Linux). `stop` and `status` compute
  their work from those identifiers: they target the recorded runtime by ID
  (no more blind every-runtime name sweep), skip a host-reused Ollama, and a
  full `stop` forgets the record. No record (older launcher, another
  machine's stack) falls back to the historical name sweep; the record is
  belief — `status` still verifies every claim against the runtime.
- `start`, `stop`, and `status` take `--service <name>` to act on one service
  (any of the ten, named by role: backend, worker, smelter, weaver, frontend,
  db, graph, vectors, inference, traces — the concrete products PostgreSQL,
  Neo4j, Qdrant, Ollama, and Jaeger appear as detail alongside). A `--service` start rejoins the running stack's
  worker secret automatically (recovered from a running container's env via
  the runtime's inspect), auto-enables OTel iff Jaeger is up, and stages a
  fresh private config copy; a `--service` stop leaves the staged configs in
  place (the rest of the stack still mounts them); a `--service` status exits
  0/1 on that service alone.
- `SEMIONT_VERSION` selects the service image tag (default `latest`; the
  sentinel `local` uses locally-built `:local` images and skips pulls).

## Development

Go module with no external dependencies. Build and test (hermetically — no Go
on the host required):

```sh
container run --rm -v "$(pwd)":/work -w /work/apps/launcher golang:1.25 \
  sh -c "go vet ./... && go test ./..."
```

The tests in `launcher_test.go` are the executable spec: golden files under
`testdata/golden/` pin the exact runtime argv sequences per scenario, and a
fake-runtime binary (`internal/fakert`) impersonates
container/docker/podman/git/lsof/ps on a private PATH — tests never touch a
real runtime. If a behavior change is intended, adjudicate against
`GO-LAUNCHER.md §3` first, then refresh goldens with
`go test -run <Test> . -update-goldens`.

The suite refuses to run when `/tmp/semiont-config.*` exists (a live stack may
be mounting those staged configs, and the launcher's preflight sweeps them) —
stop the stack first, or run the tests in a container.

## Releasing

`launcher-release.yml` runs goreleaser on every `vX.Y.Z` tag: GitHub Release
archives with SBOMs and provenance attestation, plus the Homebrew formula
pushed to `The-AI-Alliance/homebrew-semiont` (needs the `TAP_GITHUB_TOKEN`
secret). No code signing anywhere — brew-installed binaries carry no
quarantine attribute, and channels that would require a signing entity
(macOS .pkg, winget) are deliberately unoffered.
