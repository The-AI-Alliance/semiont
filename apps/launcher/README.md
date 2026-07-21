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
semiont start
semiont useradd --email admin@example.com --password mypassword --admin
semiont status
semiont logs
semiont stop
```

- `semiont start --help` lists all flags (`--config`, `--runtime`,
  `--no-observe`, `--ollama-cache`, …).
- `semiont start --service frontend --port <n>` moves the browser — the ONE
  port a flag may move (it's absent from the KB config and nothing in the
  stack dials it; every other port belongs to the config, and a codespace
  forwards only its KB on an allocated port). Move, not multiply: the
  browser restarts on the chosen port, the record carries the endpoint, and
  status/stop follow it. A non-3000 port warns that backends configured
  with `frontendURL http://localhost:3000` may reject the origin.
- **`semiont secret` registers where config secrets come from** — pointers,
  never values. `semiont secret set ANTHROPIC_API_KEY` walks an interactive
  provider-then-path flow (or pass the source directly:
  `… set ANTHROPIC_API_KEY op://OSS/Anthropic/credential`); either form
  stores `{provider, path}` in `roots.json`
  (verified with one read at set time, value discarded); every later start
  that needs the var announces the reach (`ANTHROPIC_API_KEY: reading from
  1Password (op read op://…) — expect an authorization prompt`) and reads it
  fresh — no secret value is ever persisted, echoed, or logged. The URI
  scheme selects the provider (only `op://`, the 1Password CLI, today; the
  registry is built for more). The launcher constructs the invocation itself
  from the stored path — no stored shell text is ever executed. `op` missing
  from PATH fails early and clearly. And the standing escape hatch needs no
  1Password at all: **exporting the variable always wins** — a plain
  `ANTHROPIC_API_KEY=… semiont start` behaves exactly as it always has.
  `--dry-run` reaches for nothing (plan shows `<env:VAR>` placeholders).
  `semiont secret push <VAR> --repo <owner/name>` is the one place a value
  *moves*: a codespace runs on GitHub's machine and can't reach your local
  provider, so this copies the current value into your GitHub Codespaces user
  secrets. Same discipline — resolved fresh and announced, handed to `gh` on
  **stdin** so it never appears in argv (where `ps` could read it), encrypted
  by `gh` before it leaves the machine, never written to disk or logs by us.
  The repo selection is a **union**, never a replacement, so pushing for one
  repo can't silently revoke the secret from others already using it.
- **`semiont start --runtime codespace` runs the same stack on a
  GitHub-hosted machine** (the KB's devcontainer + compose own the inside;
  the launcher orchestrates the outside via `gh`, which is required on PATH
  for this placement only). The REPO is the identity — derived from the KB
  clone's origin, or `--repo owner/name` from anywhere, needed only at
  creation: the stack record carries it afterwards, so a bare `semiont
  start` resumes the recorded codespace from any directory, and `status` /
  `logs` / `stop` dispatch off the records as always. The launcher keeps at
  most one codespace per repo (it adopts and resumes what exists — the
  codespace *name* is a PID, shown by status, input only via `--codespace`
  when raw `gh` left several). `semiont stop` maps to `gh codespace stop` —
  billing halts, state and credentials persist, the record is kept; `semiont
  stop --delete` destroys and forgets.
- **Many codespace stacks run concurrently — each forwards its KB on its
  own local port.** The record store (`stack.json`, schema 3) is a keyed
  collection: the machine's one local stack (fixed ports and container
  names keep it singleton) plus one entry per codespace repo. Each
  codespace stack forwards exactly ONE port — its KB (remote 4000) — on
  local 4000 when free, else the lowest free port above it (4001, …), so a
  single browser's Knowledge Bases panel works N codespace KBs at once
  (Host localhost, Port 400x each; browser, sidecars, and infra stay inside
  the codespace). Forwards are recorded detached processes: `status`
  re-establishes a dead one, `stop --repo` ends its own, and a LOCAL start
  drops only forwards squatting on ports it actually claims — concurrent
  KBs on allocated ports keep running. With several stacks recorded:
  `status` opens with a STACKS fleet overview (each stack's state and
  `KB localhost:<port>`) and details the lone forwarded stack (`--repo`
  details any); bare `logs` follows the local stack, else the lone
  codespace; bare `stop` and `useradd`
  let the working directory disambiguate — inside the clone whose local
  stack is running they mean local; inside a clone whose origin names a
  recorded codespace stack (no local stack) they mean that one — and refuse
  anywhere less certain: `--repo <owner/name>` targets a codespace stack,
  `--runtime` the local one. Schema 1/2 single-stack records migrate on read.
- Codespace admin credentials are generated inside the codespace at
  creation; `start` and `status` read them fresh over ssh and display them —
  never stored, never logged. Those are the FIRST admin; `useradd --repo`
  handles every user after it.
  Preflights fail fast with fixes: `gh` missing/unauthenticated, the
  `codespace` scope, the `ANTHROPIC_API_KEY` Codespaces user secret, and the
  VM class. The machine list GitHub returns for a repo is filtered by the
  devcontainer's `hostRequirements`, so anything offered is adequate by the
  KB's own declaration — `--machine` defaults to `premiumLinux` when your
  account can use it and otherwise falls back to the largest it can,
  announced with the reason; an explicit `--machine` that isn't available is
  a hard error listing what is (never a silent substitution), and on a
  resume the flag is called out as inert rather than looking effective.
  `semiont status --billing` (opt-in, needs gh's
  `user` scope — it prints the one-line grant command if missing) shows
  GitHub's own monthly usage report: compute/storage quantities, gross,
  plan-quota discounts, and the NET actually paid — their numbers verbatim,
  attributed per repository as GitHub reports it.
  Status states the burn in FACTS, never invented dollars
  (rates live on GitHub's pricing page, not in any API): an Available
  codespace shows its machine and uptime (`Available · premiumLinux 8c/32GB
  · up 3h20m`), a stopped one shows when storage billing ends by deletion
  (`storage still bills; auto-deletes 2026-08-19, state and all`), and the
  up-summary names the machine and its auto-stop.
  Every create sets the cost levers EXPLICITLY: `--idle-timeout 60m` (auto-
  stop; looser than GitHub's 30m for long pulls) and `--retention-period
  720h` (30 days — GitHub's maximum — after which a STOPPED codespace is
  auto-deleted, state and all; explicit so a tighter account default cannot
  silently shorten a KB codespace's life). Both are overridable flags on
  `semiont start`, create-time only: on a resume they are called out as
  inert, and outside codespace placement they are refused. The create
  announces both, because a default that deletes user state is never silent.
  Codespace placement is never sticky — every codespace start says
  `--runtime codespace` (or rides an existing record).
- `semiont useradd` creates or updates users in the RUNNING stack: the
  launcher execs the in-container Semiont CLI's `useradd` inside the backend
  container (record-driven runtime + container ID, name-scan fallback) and
  passes every other flag through verbatim (`--admin`, `--generate-password`,
  `--update`, `--upsert`, …). It works against **codespace stacks too** —
  one hop further out, `gh codespace ssh -- docker exec …` — with every
  argument shell-quoted, because that remote side runs through a shell
  (the local `exec` path does not, so a password with spaces or `$` is only
  a hazard on the codespace route). A codespace generates its FIRST admin at
  creation, so `useradd` there is for everything after: more users, role
  grants, password changes. With several stacks recorded it refuses to
  guess — `--repo <owner/name>` picks a codespace stack, `--runtime` the
  local one (the same vocabulary `stop` uses). This replaced `start --email/--password`: the
  admin password used to ride into the backend container as an env var,
  readable via `inspect` for the stack's whole lifetime — now it exists only
  in one exec's argv, redacted in the echoed command and the invocation log.
- `semiont start --dry-run` prints the exact runtime commands a real run would
  execute — the legibility answer to "what does this binary actually do".
- **`semiont status` reports in three layers** — LOCAL STACK (the one stack
  running here, headed by the root it belongs to and its did:web), LOCAL
  ROOTS, REMOTE KNOWLEDGE BASES (codespace-hosted KBs, their state, and each
  KB's local port). `--verbose` adds LAUNCHER PATHS — the launcher's own
  config, cache, log, state, staging and model-cache paths, which describe the
  tool rather than any KB. Roots and KBs are the durable
  things; a stack is status layered on one of them. Per service it
  shows the container STATE as the runtime sees it plus a host-side health
  probe, with the concrete product in the service cell (`database
  (PostgreSQL)`). **A role's platform decides which verbs it has, and a role
  need not run here.** `embedding` is a role like any other; its platform is
  external in both shapes — `type = "ollama"` is served by the same Ollama the
  `inference` role provides, `type = "voyage"` is remote SaaS — so it appears
  in status (runtime `external`) and supports no start/stop, exactly as an
  anthropic-typed `inference` or an external `graph` does. A KB with no
  `[embedding]` section gets a `not configured` row rather than silence.
  **Exit status:** the default report spans several stacks,
  so it exits 0 whenever status itself ran — to script health, name one
  stack: `--root <path|name>`, `--repo <owner/name>`, or `--service <name>`.
- **A codespace KB's `did:web` is recorded, never inferred.** It is read from
  the clone whose origin named the repo, or — for a `--repo`-only start with
  no clone anywhere — from the codespace itself, over the ssh `start` and
  `status` already make for the admin credentials. `status --repo <owner/name>
  --refresh` re-reads it to confirm; a disagreement is reported, never
  silently overwritten. **No reporting command ever wakes a stopped
  codespace** (an ssh would, resuming compute billing), so `--refresh` on a
  stopped one says so and skips.
- **A failed health gate shows the crash where it is**: the launcher prints
  the last ~20 lines of that container's own logs plus the `semiont logs
  --service <name>` pointer — the cause of a startup crash is usually
  sitting right there (a friction log spent most of a day on an errno -35
  event-log read failure that was in `logs` for the whole 120s backend
  wait). Service containers run **without `--rm`** for the same reason: a
  container that CRASHES during the gate used to remove itself, destroying
  the very logs that explain it ("No such container"). It now remains,
  Exited and inspectable — status shows it, `semiont logs` reads it — until
  the next start's preflight or a stop sweeps it. Cleanup was always the
  launcher's explicit job at both ends; `--rm` only ever subtracted the
  evidence. (One-shot busybox probes keep `--rm` — nothing to keep.) And on macOS, a KB root under `~/Desktop`, `~/Documents` (only when
  Finder's "Desktop & Documents Folders" iCloud sync is actually on), or
  `~/Library/Mobile Documents` draws a start-time WARNING: iCloud evicts
  file content, and container reads of evicted files fail with that errno
  -35 — typically only once the event log is non-empty, which masquerades as
  a regression. A warning, not a refusal: eviction state isn't stable, and
  the same setup can run fine for months.
- **The Browser discovery view** (BROWSER-KB-DISCOVERY.md lane 1): every
  stack mutation regenerates `<state>/discovery/kbs.json` — each managed KB's
  localhost endpoint, placement, did:web and site name; `managedBy:
  semiont-launcher` so the Browser can split managed from manual entries.
  Endpoints and identity only, never a secret. The frontend container mounts
  the directory read-only at `/discovery` — inert until the frontend image
  serves it (lane 2); an empty stack set writes an empty list, because an
  absent file is ambiguous.
- `semiont stop` sweeps **every** installed runtime by default, so a stack
  started under `--runtime docker` can't survive a plain stop. Stop's job
  isn't done until the ports are actually free: `start` records the host
  ports the stack claimed (`ports` in `stack.json`), and `stop` polls them
  after teardown (runtimes release published ports asynchronously), then
  reports any survivor with its PID and process name — never kills it, since
  after the sweeps a holder is provably not a Semiont container. `start`'s
  preflight likewise name-sweeps `semiont-*` under every installed runtime,
  so a held port at check time means a genuinely foreign process; the error
  names it and suggests the `kill` for you to run yourself. (There is
  deliberately no `--force-kill-ports`-style option: the launcher owns
  everything named `semiont-*` across every runtime it can see, and never
  signals anything else.)
- `semiont about` shows what Semiont is, project links, the image registry,
  and which runtimes were detected on PATH.
- Every invocation is logged (invoke + exit lines, with `--password` values
  redacted) to `launcher.log` in the launcher's log home: `~/Library/Logs/
  semiont` on macOS, `$XDG_STATE_HOME/semiont` (default
  `~/.local/state/semiont`) on Linux. `semiont status --verbose` lists the dir
  under LAUNCHER PATHS. Logging is best-effort — it never blocks a command.
- **The launcher derives its work from the KB's semiontconfig TOML** — the
  same file the Semiont containers read (see
  `docs/system/administration/CONFIGURATION.md`). Per dependency role
  (graph, vectors, database, inference, embedding) the config decides the
  obligation — the launcher's name for the npm CLI's `platform`:
  an address on a launcher-injected `${*_HOST}` var → the launcher provides
  a container (driver by `type`, credentials/ports from the config); any
  other address → externally provided (verified, never launched, skipped by
  stop, shown as "external" in status); `platform = "posix"` → host-process
  reuse; section absent / unreferenced → nothing launched, "not configured"
  in status. **The inference driver is who performs inference per the
  bindings, not which process the launcher runs**: any ollama-typed binding →
  the local-Ollama shape (host-process dance, container fallback); all-remote
  bindings (Claude throughout) → `inference (Anthropic)`, an external SaaS
  role that launches nothing. In that second shape the local Ollama the
  config still needs exists solely for the embedding, so **embedding owns
  it** — the row reads `embedding (Ollama)` with the host/container runtime,
  the model pulls ride on it, and its launched container is embedding's to
  stop. With ollama bindings, embedding instead rides the inference role's
  Ollama and reports the same provider — one process is never described two
  ways. `type = "voyage"` is remote SaaS; either way embedding has a status
  row and start/stop belongs to whatever provides it.
- **The inference and embedding rows list their models.** Which models a stack
  uses is config truth, recorded at start (the union of `actors.*` and
  `workers.*` inference models, and `embedding.model`); whether each is pulled
  is verified live against Ollama's `/api/tags` and `/api/ps`, with size,
  parameter count and quantization. **Nothing in the launcher pulls models**, so
  a model that was never pulled is otherwise invisible until a worker reaches
  for it mid-job and fails. **`semiont start` now pulls them**: after Ollama is
  up it lists what is installed and pulls each configured model that is
  absent, over Ollama's HTTP API (one path for both a host process and the
  launcher's container — no `ollama` CLI needed on PATH). Only models Ollama
  can actually serve are pulled: ollama-typed bindings plus an ollama
  embedding, never a Claude. If Ollama cannot be listed, NOTHING is pulled —
  unknown is not missing, and re-downloading gigabytes a user already has is
  the worse error. A failed pull warns and leaves the stack running rather
  than aborting it. Status still marks anything absent `MISSING` with the
  `ollama pull` to fix it. **Remote (Anthropic) models get the same treatment
  through `/v1/models`**: while the API key is in hand at start, one GET
  records each configured model's display name, release month, and context
  window — and warns when a model is NOT listed for that key (withdrawn, or a
  typo'd id), the remote analog of MISSING and today's only signal before a
  job fails on it. Status renders the recorded metadata, refreshing it live
  only when `ANTHROPIC_API_KEY` is already in its environment — status never
  resolves secrets. NO costs: Anthropic exposes no price list programmatically
  (the pricing page is docs-only; actual spend needs the org-level Admin API,
  a different credential — see GO-LAUNCHER.md follow-ups). An unreachable Ollama reads `unknown`, never `missing`: ignorance
  and a finding are different answers. Untagged config names are matched
  against Ollama's `:latest` form. Remote models (Claude, Voyage) list as
  `remote` — there is nothing to install.
  Moving `database.port` moves the publish/checks/gates with it;
  a local Ollama runs only when the config references ollama — owned by
  inference when the bindings use it, by embedding when only the embedding
  does. An optional `image`
  key per role section overrides the catalog's default image — a KB can pin
  or upgrade an infra image without a launcher release. `--dry-run` renders
  the derived plan.
- KB-root discovery matches the npm CLI (`SEMIONT_ROOT`, analogous to
  `GIT_DIR`): the override is strict (invalid values error, never fall back),
  else the root is found by walking up from cwd for `.semiont/`. git is not
  part of discovery — the must-be-a-git-clone invariant applies only where
  `/kb` is mounted (full start, `--service backend`); sidecars need only the
  `.semiont/` tree. `semiont status` reports the root(s) in its LOCAL ROOTS
  section.
- The launcher remembers every root a real start used in `roots.json` (beside
  `stack.json`; entries survive stops, vanished paths are flagged not
  dropped). `semiont start --root <path|name>` selects a root explicitly — a
  directory, or the basename of a registered root — winning over
  `SEMIONT_ROOT` and cwd discovery; the LOCAL ROOTS status section lists
  the registry with last-used annotations.
- **`--config` is sticky per KB**: a successful start with an explicit
  `--config` records the name on the root's `roots.json` entry, and later
  starts without the flag use it (banner says `Config: anthropic (recorded
  from last start; override with --config)`; status shows it under SEMIONT
  ROOTS). An explicit flag always wins and re-records; failed starts and
  `--dry-run` record nothing, so a typo'd name never becomes the default.
  The preference is per-user-per-machine — which config you run depends on
  your API keys, so it lives in the XDG registry, never in the KB repo.
- **`--runtime` is sticky machine-wide** (a top-level `runtime` field in
  `roots.json` — stacks are singleton-per-machine, so unlike `--config` the
  preference isn't per-KB): an explicit `--runtime` on a successful start is
  recorded; later bare starts use it (`Container runtime: docker (recorded
  from last start; override with --runtime)`). Selection is three-tiered — a
  live stack's `stack.json` record always wins (rejoin what exists), then the
  recorded preference, then auto-detect (`container` → `docker` → `podman`).
  Ambiguous auto-detect names the alternatives (`auto-detected; also on
  PATH: docker`); implicit picks record nothing; a preference naming a
  runtime that's no longer on PATH warns and falls back to auto-detect —
  only an explicit flag naming a missing runtime is an error.
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
  database, graph, vectors, inference, traces — the concrete products PostgreSQL,
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
