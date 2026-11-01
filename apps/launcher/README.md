# semiont launcher

A host-installed CLI that runs a local Semiont stack by driving your container
runtime (Apple `container`, Docker, or Podman) directly: Semiont's seven
services (gateway, dispatcher, archivist, librarian, worker, smelter, weaver)
and the Browser, and beside them Keycloak, PostgreSQL, NATS, Neo4j, Qdrant,
the telemetry containers and, when a model runs locally, Ollama. The operator's
[service catalog](../../docs/operator/services/OVERVIEW.md) says what each is
for.

## What this is for

The launcher is the **laptop path**: one command brings up a full stack on a
machine with no scheduler running. It is not the only way to run Semiont, and
it is not a dependency of the service images.

The published images are standalone artifacts. They run against whatever
PostgreSQL, Neo4j, Qdrant and inference you already have, under Kubernetes, ECS
or Nomad, with no launcher involved — see
[DEPLOYMENT.md](../../docs/operator/administration/DEPLOYMENT.md) for the
supported paths and the contract each one must satisfy.

What the launcher adds on top of `run` is the part those platforms leave to
you: per-root state directories with ownership stamps and mismatch rules,
configuration staging and secret delivery, the per-service issuer credentials, the discovery
document, explicit memory ceilings, start ordering, and readiness gates.

What it deliberately is **not** is a scheduler. `semiont start` brings the
stack up and exits; nothing stays resident to reconcile desired state. That one
fact explains a good deal of what follows, including how services stay alive.

## Install

```sh
brew install the-ai-alliance/semiont/semiont
```

macOS, Linux and Windows, arm64 and amd64. Homebrew serves macOS and Linux;
the [GitHub Release](https://github.com/The-AI-Alliance/semiont/releases)
carries an archive for each system, for Windows a zip holding `semiont.exe` —
see [Semiont on Windows](../../docs/operator/platforms/WINDOWS.md), which also
covers running the Linux build inside WSL2. The binary is static: no language
runtime bleeds onto your host. Besides the launcher you need only `git` and
one container runtime (`container`, `docker`, or `podman`) on PATH.

## Use

Run from inside a KB clone — or birth one first with **`semiont init`**
Interactive with full flag
parity; `--yes` refuses rather than guessing where no safe default exists.
What init does:

- **Identity at birth**: the permanent did:web domain from `--domain`, the
  git origin (`<owner_lc>.github.io:<name>` — the same rule the template's
  post-fork action applies), or a prompt that says plainly this is the
  identity stamped into the committed event log.
- **Documents built, not copied**: `--inference anthropic|ollama --model <id>
  --embedding ollama:<model>` writes the stack's documents into
  `.semiont/stack/` from the launcher's own knowledge — the images and memory
  of its catalog, and an Inference document that gives both actors and every
  job one engine, the model chosen (per-job refinement is your edit, under
  `spec.engines.jobs.mark.<motivation>` and `spec.engines.jobs.yield`).
  NOTHING is mastered anywhere.
- **Choices validated live**: with a key, Anthropic models validate against
  `/v1/models` (an unlisted id is a refusal printing what exists; no
  `--model` picks the newest capable, announced); Ollama models pass as
  installed or registry-verified ("pulled at start"), refuse on the
  registry's 404, and degrade to accept-with-warning when sources are
  unreachable — unknown is not missing.
- **Or copy from the template, explicitly**: `--from-template [url|dir]`
  shallow-clones and copies its `.semiont/stack/` — vetted, all-or-nothing
  — and `--devcontainer` copies the codespace set with the display name
  rewritten to yours, making a locally-born KB `--runtime codespace`
  eligible. Identity is NEVER copied.
- **Every document write — generated or copied — passes the plan deriver
  first**: a bug or a version-skewed template is a pre-write refusal
  carrying the parser's own error, never a KB that cannot start.
- **A generated KB's gateway port is one no known KB commits**: the lowest
  of 4000, 4010, 4020, … that no other root in the registry's
  `knowledge-base.yaml` names. A copied template keeps the template's.

```sh
semiont init --yes --inference anthropic --embedding ollama:nomic-embed-text
```

births a startable KB in one command (identity from your git origin). Then:

```sh
semiont start
semiont useradd --email admin@example.com   # prompts for the password
semiont status
semiont logs
semiont stop
```

- `semiont start --help` lists all flags (`--config`, `--runtime`,
  `--no-observe`, `--ollama-cache`, …).
- **Each KB's stack is published on a port block of its own**, kept on its
  row of `roots.json` (`portBlock`): its first successful start takes the
  lowest block no other row keeps, and `semiont forget` frees it. Block k
  publishes every port the launcher chooses for the stack at its block-0
  port + 10k (PostgreSQL 5432, NATS 4222, Qdrant 6333, Neo4j 7474/7687,
  Keycloak 8080, the Smelter, Weaver, Archivist, Librarian and Dispatcher
  24101–24105); each container listens where it always does, and every
  document the start stages names the published ports. The gateway's port
  is its document's, Keycloak's is `KEYCLOAK_PORT` or the recorded one when
  either is set, and the machine's containers keep theirs. A dry run plans
  on the block a start would take and keeps none. A stop with no record
  verifies every kept block's service and broker ports released.
- **Several KBs run side by side.** Each KB's containers are named for it,
  `semiont-<kb>-<product>` (`<kb>` is its did:web domain with each run of
  characters outside `A-Za-z0-9._-` replaced by one `-`), and its stack is
  recorded, and its sign-in kept, under `local:<kb>`. A start leaves every
  other KB's stack running. It refuses a second copy of a KB that another
  clone is running, and a port another running stack claims: two clones of
  one template both commit gateway port 4000, so the second needs a port of
  its own in its `knowledge-base.yaml`. The machine's containers (the worker,
  Ollama, the Browser, the telemetry) serve every KB; `stop` stops them with
  the last local stack. Commands act on the KB whose clone you stand in, or
  the one `--root <path>` names, and a bare one that finds several stacks
  and stands in none refuses, listing a command for each.
- **The Browser is not a stack member**: it is the machine-level viewer of
  every KB, local and codespace, discovery-synced. **Its document says how it
  runs**: `stack/browser.yaml` in the state home, kind `Browser`
  (`specs/src/stack/Browser.json`), naming its image, its memory and the port
  it is published on, read with the reader a KB's documents are. The first
  command that needs it and finds none writes it from the launcher's catalog
  (`semiont-browser:latest`, 1G, port 3000) and says where; from then on the
  file is what runs, and one that does not hold refuses the start, with its
  line, before anything is stopped or started.
  ANY start ensures it — including a codespace start, when a local container
  runtime exists — and none churns it: a running Browser is KEPT when it runs
  the image the start would (image identity, not tag order) and its record
  says it was started with its document's port and memory; it is restarted
  otherwise, and when no record names it. `semiont stop` stops it with the stack, from its own
  record and under its own runtime; `semiont stop --service browser` stops it
  alone, and `semiont stop --repo` leaves it. Its record
  lives beside the stacks (machine-level, with its runtime and image), its
  port is never among a stack's claims, and `status` reports it under
  KNOWLEDGE WORKERS, beside the worker, showing its image tag so
  browser-vs-stack version skew is visible.
- `semiont start --service browser` is the explicit refresh: it always
  restarts the Browser, bypassing keep-if-current. Its port moves with an
  edit of its document; the realm's origin for the new port is added by
  `semiont identity sync`, which the preflight names when it is missing.
- **The machine's Ollama is not a stack member either**: one Ollama serves
  every KB on the machine whose documents name `ollama` with no address.
  When the launcher runs it as a container (`semiont-ollama`, when none is
  installed on the machine), its record lives beside the stacks, as the
  Browser's does, with its runtime, image, the address it is published at
  and the model cache it mounts; its port is never among a stack's claims,
  and the stack records the role it serves as provided by the machine. A
  start KEEPS a running one when it runs the image the start would and its
  record says it was started under this start's runtime, at the address
  this start would publish it on, and on the model cache `--ollama-cache`
  asks for, when it asks for one; it is restarted otherwise, and when no
  record names it. Kept or not, the start pulls the models its documents
  name that Ollama lacks. `semiont start --service inference` always
  restarts it. `semiont stop` stops it with the stack; `semiont stop
  --service inference` stops it alone (`--service embedding`, where the
  stack runs it for the embeddings alone), and a stop of any other one
  service leaves it.
- **The telemetry is the machine's too**: one OTel collector takes every
  KB's signals, each labelled with the KB that sent it, with Jaeger and
  Prometheus behind it. Their records live beside the stacks, as the
  Browser's and Ollama's do, and their configs (`collector.yaml`,
  `prometheus.yml`) in `machine/` in the state home, written only as
  their container (re)starts; their ports are never among a stack's claims.
  A start KEEPS a running one when it runs the image the start would, its
  record says this start's runtime and address, and its config is what this
  start would write; it is restarted otherwise, and when no record names it.
  The collector sends traces to Jaeger whenever Jaeger answers, so a start
  that brings Jaeger back restarts the collector into sending to it.
  `--no-observe` starts neither Jaeger nor Prometheus, and leaves running
  ones alone. `semiont start --service collector|traces|metrics` always
  restarts that one; `semiont stop` stops them with the stack, and `semiont
  stop --service collector|traces|metrics` stops that one alone.
- **The worker's settings are the machine's too**: `stack/workers.yaml` in
  the state home, kind `WorkerPool` (`specs/src/stack/WorkerPool.json`),
  naming its image, its memory and its log level, written and read as the
  Browser's is (`semiont-worker:latest`, 2G, info) by the first start that
  runs a worker. A KB's repository holds none: its Inference document's
  `spec.engines.jobs` says which jobs a worker does, and with which engines.
- **One worker serves the machine's list of KBs** (`semiont-worker`). A
  KB's start puts it on the list when one of its jobs has an engine, as that
  start places it, and takes it off when none does; `semiont worker kb add`,
  run inside a KB on the list, adds a KB someone else runs, offered that
  one's engines. The list is kept in `machine/worker-knowledge-bases.json`
  in the data home, beside the worker's key, and the worker's document,
  naming every KB on it, in `machine/worker.json` in the state home. Until
  each local KB has a gateway port of its own, a start takes off the list
  any other local KB whose gateway was on its port, and says so; a KB added
  from one taken off goes unserved, and is said, until that one's next
  start. A start resolves every provider key the list's engines name, and
  refuses when one is missing, naming the KB that names it. The worker's
  record lives beside the stacks and its port is never among a stack's
  claims. A start KEEPS a running worker when it runs the image and memory
  the start would, its record says this start's runtime and address, and
  its document is what this start would write; it is restarted otherwise,
  and stopped when its list is empty. `semiont start --service worker`
  always restarts it; `semiont stop` stops it with the stack, and `semiont
  stop --service worker` stops it alone.
- **`semiont settings` lists every setting the launcher keeps**, with its
  value and where the value came from: the container `runtime`, where your
  own secrets come from (`secret`), the Browser's document (`browser`: its
  path, image, memory and port, changed by editing it; `semiont settings
  browser --path` prints the path alone, for a script), the worker's
  (`worker`: its path, image, memory and log level, and `--path` likewise), who reaches a local stack (`network`: `local`, or `lan`, where the network
  reaches the gateway and the issuer's realm through the launcher's own
  filtering proxy, `semiont issuer-proxy`, a recorded detached process), and
  the default store for new KBs (`secret-store --default`) on this machine;
  and for the KB you are in (or `--root`), its `config` (the Inference
  document a start runs), `keycloak-port` and `secret-store`.
  `semiont settings <name> <value>` sets one, checked as a start would check
  it, and `--unset` returns it to its default. Showing reads no secret and
  contacts no store. The Homebrew formula's caveat points a new install here;
  every command it names is checked to exist (`caveat_test.go`).
- **`semiont settings secret` registers where the secrets a document names come from** — pointers,
  never values. `semiont settings secret set ANTHROPIC_API_KEY` walks an interactive
  provider-then-path flow (or pass the source directly:
  `… set ANTHROPIC_API_KEY op://OSS/Anthropic/credential`); either form
  stores `{provider, path}` in `roots.json`
  (verified with one read at set time, value discarded); every later start
  that needs the var announces the reach (`ANTHROPIC_API_KEY: reading from
  1Password (op read op://…) — expect an authorization prompt`) and reads it
  fresh — no secret value is ever persisted, echoed, or logged. The URI
  scheme selects the provider (only `op://`, the 1Password CLI; the
  registry is built for more). The launcher constructs the invocation itself
  from the stored path — no stored shell text is ever executed. `op` missing
  from PATH fails early and clearly. And the standing escape hatch needs no
  1Password at all: **exporting the variable always wins** — a plain
  `ANTHROPIC_API_KEY=… semiont start` uses that value.
  `--dry-run` reaches for nothing (plan shows `<env:VAR>` placeholders).
  `semiont settings secret push <VAR> --repo <owner/name>` is the one place a value
  *moves*: a codespace runs on GitHub's machine and can't reach your local
  provider, so this copies the current value into your GitHub Codespaces user
  secrets. Same discipline — resolved fresh and announced, handed to `gh` on
  **stdin** so it never appears in argv (where `ps` could read it), encrypted
  by `gh` before it leaves the machine, never written to disk or logs by us.
  The repo selection is a **union**, never a replacement, so pushing for one
  repo can't silently revoke the secret from others already using it.
- **`semiont settings secret-store` says where a KB keeps the values the launcher
  generates for it** — the token-signing key, Keycloak's admin password, the
  service accounts' secrets, the daemons' passwords. `file` (the default) is
  one 0600 plain-text file per value under the KB's state dir — **not secure:
  for development only**, and every place the launcher names it says so;
  `op://<vault>` is one
  1Password Secure Note per KB in that vault, one concealed field per value,
  values on stdin only. Naming a store moves every kept value (copy, read
  back, record, delete from the old store) and refuses a store that already
  holds this KB's values; with no value it names the store and where each
  value is kept, from the setting alone. `secret-store --default
  op://<vault>` is the store a new KB (no store of its own, nothing in files)
  adopts at its first start, recorded as its own, so changing the default
  moves nothing. The settings are per machine, in `secretstores.json`, read
  strictly: a store that cannot be read or reached stops the command, never
  falling back to another.
  **Every store read, write and delete prints a line on stderr** — the
  operation and the secret's name, never its value — `--quiet` included. An
  unscoped `clean` deletes a KB's values through its store.
- **`semiont start --runtime codespace` runs the same stack on a
  GitHub-hosted machine** (inside, the codespace's own launcher runs the
  stack — `semiont start --runtime docker`, from the KB's post-start hook;
  this one orchestrates the outside via `gh`, which is required on PATH for
  this placement only). The REPO is the identity — derived from the KB
  clone's origin, or `--repo owner/name` from anywhere, needed only at
  creation: the stack record carries it afterwards, so a bare `semiont
  start` resumes the recorded codespace from any directory, and `status` /
  `logs` / `stop` dispatch off the records as always. The launcher keeps at
  most one codespace per repo (it adopts and resumes what exists — the
  codespace *name* is a PID, shown by status, input only via `--codespace`
  when raw `gh` left several). Every `--repo` verb finds it the same way —
  the record, else what GitHub lists for the repo — so a codespace whose
  setup failed before anything was recorded can still be stopped, deleted,
  inspected, or given users; verbs that dial the KB (`login`, `yield`) need
  its forward on this machine, and say to `start` it first. `semiont stop` maps
  to `gh codespace stop` —
  billing halts, state and credentials persist, the record is kept; `semiont
  stop --delete` destroys and forgets. The two long waits narrate
  themselves: the VM wait redraws the polled state with elapsed time, and a
  fresh create's health wait tails the devcontainer creation log (`gh
  codespace logs --follow`) as a sliding window of its last few lines —
  cleared once healthy; piped output gets 30-second heartbeat lines
  instead.
- **Many codespace stacks run concurrently — each forwards its KB on its
  own local port.** The record store (`stack.json`, schema 3) is a keyed
  collection: one entry per running local knowledge base (`local:<did-key>`,
  its containers named for it) plus one per codespace repo. Each
  codespace stack forwards TWO ports. Its KB (remote 4000) goes on local
  4000 when free, else the lowest free port above it (4001, …). Its issuer —
  `http://keycloak.localhost:<N>`, loopback here — goes `<N>:<N>`, the same
  number on both ends because a token's `iss` must match the one URL the
  Browser signs in at: 8080 when free, else the lowest free above it. When
  the codespace's Keycloak is on another port, its own launcher restarts the
  stack there with `KEYCLOAK_PORT=<N>`, which it records for every later
  resume. A single browser's Knowledge Bases panel therefore works, and
  signs in to, N codespace KBs at once (Host localhost, Port 400x each;
  sidecars and infra stay inside the codespace). An issuer the codespace
  does not run is not forwarded. Forwards are recorded detached processes: `status`
  re-establishes a dead one, `stop --repo` ends its own, and a LOCAL start
  drops only forwards squatting on ports it actually claims — concurrent
  KBs on allocated ports keep running. With several stacks recorded:
  `status` opens with a STACKS fleet overview (each stack's state and
  `KB localhost:<port>`) and details the lone forwarded stack (`--repo`
  details any); bare `logs`, `stop`, `useradd` and the knowledge verbs
  let the working directory disambiguate — inside a clone they mean its
  knowledge base, as `--root` would name it, unless nothing started it and a
  codespace stack is recorded: then, with no local stack recorded, the lone
  codespace stack or the one the clone's origin names, and otherwise they
  refuse and list each. Standing in no clone, a lone recorded stack answers
  for itself. They refuse anywhere less certain:
  `--root <path>` targets a local KB's stack, `--repo <owner/name>` a
  codespace stack, and `--runtime` narrows the choice to local stacks.
- Codespace preflights fail fast with fixes: `gh` missing/unauthenticated, the
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
- `semiont useradd` creates or updates users at the stack's issuer: a local
  realm is administered by this launcher directly, a codespace's by the
  launcher over there, reached by ssh. Flags are `--generate-password`,
  `--update`, `--upsert`, …; there are no role flags, because no route grants
  access on the basis of a role. The ISSUER owns the account, the profile and
  the password hashing; this launcher only decides which stack is meant. The password is the one thing it does NOT pass as an argument: it is
  prompted for on a terminal (or read from stdin when piped) and fed to
  `--password-stdin` down the exec's pipe, because argv is readable by every
  process on the host via `ps` and lands in the caller's shell history. It works against **codespace stacks too** — one hop further out,
  `gh codespace ssh -- docker exec …` — with every argument shell-quoted,
  because that remote side runs through a shell (the local `exec` path does
  not, so a password with spaces or `$` is only a hazard on the codespace
  route). **Nothing auto-creates an account, codespace or local**: a fresh
  stack has no users, so this is how the first admin comes to exist. With
  several stacks recorded it refuses to guess — `--root <path>` picks a
  local KB's stack, `--repo <owner/name>` a codespace stack (the same
  vocabulary `stop` uses). `start` takes no `--email`/`--password`: a password given to it
  would ride into a container as an env var, readable via `inspect` for
  the stack's whole lifetime. Here it is piped to `--password-stdin` and is
  never on a command line.
- `semiont start --dry-run` prints the exact runtime commands a real run would
  execute — the legibility answer to "what does this binary actually do".
- **No secret value is ever on a container's command line**, where `ps` shows
  it to every user on the machine. A container gets `--env NAME`, and the
  value crosses through the runtime command's own environment: service-account
  secrets, the token-signing key, the variables a document names such as
  `ANTHROPIC_API_KEY`, and the databases' passwords alike. Hosts, ports, client
  ids and paths stay visible. `inspect` still shows a running container's
  environment; that is what delivering secrets as environment means.
- **`semiont status` reports by what each service is part of.** KNOWLEDGE
  BASES has an entry for each knowledge base's stack — the one of the KB you
  stand in, else each one running — headed by its name and did:web: its
  clone, where it runs, where its secrets are kept, and a line each for its
  record, index and issuer, a mark per service and the state of any that is
  not healthy. Then how many KBs are known, local file:// clones and
  codespace-hosted https:// repos alike (`semiont roots` lists them). The
  services every knowledge base shares follow, a table for each group:
  KNOWLEDGE WORKERS (the Browser and the worker), PROVIDERS (inference and
  embedding, with the models each KB was started with) and TELEMETRY (the
  collector, Jaeger and Prometheus). Each service is there once, naming the
  KBs it serves when the report covers several. `--verbose` adds LAUNCHER
  PATHS — the launcher's state
  home, log, config staging and model cache; then, for the knowledge base
  the command was run in, its `KB root` and the directory its stores are in
  (`its stores`), with each store's own directory, what it takes on disk and
  what it holds, largest first; and an `all KBs` row totaling every
  knowledge base's directory, with orphaned ones (the KB root no longer
  exists) called out alongside the `semiont clean --root <key>` that
  removes each. Sizes are what the files take on disk, not their lengths: a
  vector store's sparse files are long and take little. Roots and KBs are the durable
  things; a stack is status layered on one of them. A service's row — each
  shared one's, and any one's under `--service <name>` — shows the container
  STATE as the runtime sees it plus a host-side health probe and the address
  it asked, with the concrete product in the service cell (`identity-store
  (PostgreSQL)`). **Who runs a role decides which verbs it has, and a role
  need not run here.** `embedding` is a role like any other, and somebody
  else runs it in both shapes — an `ollama` embedding is served by the same
  Ollama the `inference` role provides, a `voyage` one is remote SaaS — so it
  appears in status (runtime `external`) and supports no start/stop, exactly
  as an Anthropic `inference` or an external `graph` does.
  **Exit status:** the default report spans several stacks,
  so it exits 0 whenever status itself ran — to script health, name one
  stack: `--root <path|name>`, `--repo <owner/name>`, or `--service <name>`.
- **A codespace KB's `did:web` is recorded, never inferred.** It is read from
  the clone whose origin named the repo, or — for a `--repo`-only start with
  no clone anywhere — from the codespace itself, over ssh. `status --repo
  <owner/name> --refresh` re-reads it to confirm; a disagreement is reported,
  never silently overwritten. **No reporting command ever wakes a stopped
  codespace** (an ssh would, resuming compute billing), so `--refresh` on a
  stopped one says so and skips.
- **A failed health gate shows the crash where it is**: the launcher prints
  the last ~20 lines of that container's own logs plus the `semiont logs
  --service <name>` pointer — the cause of a startup crash is usually
  sitting right there. Service containers run **without `--rm`** for the
  same reason: with it, a container that CRASHES during the gate removes
  itself, destroying the very logs that explain it ("No such container").
  Without it the container remains,
  Exited and inspectable — status shows it, `semiont logs` reads it — until
  the next start's preflight or a stop sweeps it. Cleanup is the
  launcher's explicit job at both ends; `--rm` would only subtract the
  evidence. (One-shot busybox probes keep `--rm` — nothing to keep.) And on macOS, a KB root under `~/Desktop`, `~/Documents` (only when
  Finder's "Desktop & Documents Folders" iCloud sync is actually on), or
  `~/Library/Mobile Documents` draws a start-time WARNING: iCloud evicts
  file content, and container reads of evicted files fail with that errno
  -35 — typically only once the event log is non-empty, which masquerades as
  a regression. A warning, not a refusal: eviction state isn't stable, and
  the same setup can run fine for months.
- **The Browser discovery view**: every
  stack mutation regenerates `<state>/discovery/kbs.json` — each managed KB's
  localhost endpoint, placement, did:web and site name; `managedBy:
  semiont-launcher` so the Browser can split managed from manual entries.
  Endpoints and identity only, never a secret. The schema authority is
  `specs/src/discovery/DiscoveryDocument.json`, and BOTH languages
  generate from it — @semiont/core's types.ts via the OpenAPI pipeline, and
  this launcher's `discovery_types_gen.go` via go-jsonschema (go:generate in
  discovery.go) — so schema drift is a compile error, not a convention. The
  Browser container mounts the directory read-only at `/discovery`, where the
  Browser image's server serves it; an empty stack set writes an empty list,
  because an absent file is ambiguous.
- `semiont stop` sweeps **every** installed runtime by default, so a stack
  started under `--runtime docker` can't survive a plain stop. Stop's job
  isn't done until the ports are actually free: `start` records the host
  ports the stack claimed (`ports` in `stack.json`), and `stop` polls them
  after teardown (runtimes release published ports asynchronously), then
  reports any survivor with its PID and process name — never kills it, since
  after the sweeps a holder is provably not a Semiont container. `start`'s
  preflight likewise name-sweeps its knowledge base's containers
  (`semiont-<kb>-*`) under every installed runtime, and refuses a port another
  knowledge base's running stack claims, naming it; so a held port at check
  time means a genuinely foreign process, and the error names it and suggests
  the `kill` for you to run yourself. (There is
  deliberately no `--force-kill-ports`-style option: the launcher owns
  everything named `semiont-*` across every runtime it can see, and never
  signals anything else.)
- **`semiont stop --group <name>` stops one group of services**, named as
  `status` reads them. A knowledge base's group (`record`, `index`,
  `issuer`) takes along each of that knowledge base's services that needs
  one of its own, last-started first, and says which and why ("smelter
  stops too: it needs the gateway"). So `--group index` stops the librarian,
  the smelter, the weaver, the graph and the vectors and nothing else, and
  `--group issuer` stops every service behind the gateway. The worker goes
  with a knowledge base's group only when no other local stack is
  recorded, as with a bare stop. A shared group (`knowledge-workers`,
  `providers`, `telemetry`) serves every knowledge base here, so it stops
  alone, and each knowledge base goes on without it.
- **`semiont start --group <name>` starts one group of services**, as
  `--service` starts one: each of the group's own (re)starts, in start
  order. Each service one of them needs that is not up starts first, and
  the start says which and why ("gateway starts too: the weaver needs it").
  So after `semiont stop --group record`, `semiont start --group index`
  starts the messaging, the gateway and the archivist again before the
  index; with the stack up, it restarts the index alone. A group that reads no config
  (`telemetry`) starts from anywhere.
- `semiont about` shows what Semiont is, project links, the image registry,
  and which runtimes were detected on PATH.
- Every invocation is logged (invoke + exit lines, with `--password` values
  redacted) to `launcher.log`, in the launcher's log directory
  ([where](#where-the-launcher-keeps-its-files)). `semiont status --verbose`
  lists it under LAUNCHER PATHS. Logging is best-effort — it never blocks a
  command.
- **The launcher derives its work from the KB's documents in
  `.semiont/stack/`** — the files every service's configuration is written
  from (see `docs/operator/administration/CONFIGURATION.md`), each held to its
  schema in `specs/src/stack/` before anything launches. For each daemon a
  document describes (the graph, the vectors, the broker, the issuer's
  database) it states who runs it, one way or the other and never both
  (`specs/src/stack/Runner.json`): `image` and `resources` → the launcher
  provides a container from that image and places it; `external` → somebody
  else runs it: the document states its address, and it is verified, never
  launched, skipped by stop and shown as "external" in status. The issuer is
  the KnowledgeBase's `spec.issuer`: `ref` names the Issuer document of a
  Keycloak the launcher runs, `external` an issuer somebody else runs. An
  `ollama` provider or embedding that states no address is the machine's
  Ollama (host-process reuse, container fallback); a remote provider
  (Anthropic, Voyage) is somebody else's by its type.
  **Deployment topology is the launcher's to know, never the documents' to
  declare.** A document says what a knowledge base needs — a graph, a vector
  store, an embedding model, an issuer — and, of the daemons the launcher
  runs, nothing of where they listen, so the files are the same on every
  machine. Each service's document states every address this start placed,
  as a literal: the gateway's, the dispatcher's, the Archivist's, the
  worker's, the Smelter's, the Weaver's and the Librarian's. The gateway's,
  the dispatcher's, the Smelter's, the Weaver's and the Librarian's also name
  the knowledge base the service serves (`kb`); the Archivist reads it from the
  tree it keeps. Every service but the worker names it by its DID in its
  telemetry (`semiont.kb`), by which `semiont status` reads that knowledge
  base's numbers and no other's. One address reaches a container through its
  environment instead: the telemetry collector's
  (`OTEL_EXPORTER_OTLP_ENDPOINT`). `semiont start --dry-run` lists
  what it would place.
  **The inference driver is who performs inference per the
  engines, not which process the launcher runs**: any engine on `ollama` →
  the local-Ollama shape (host-process dance, container fallback); all-remote
  engines (Claude throughout) → `inference (Anthropic)`, an external
  SaaS role that launches nothing. In that second shape the local Ollama the
  KnowledgeIndex's embedding still needs exists solely for the embedding, so
  **embedding owns it** — the row reads `embedding (Ollama)` with the
  host/container runtime, the model pulls ride on it, and `--service
  embedding` restarts and stops it. With engines on `ollama`, embedding instead
  rides the inference role's Ollama and reports the same provider — one
  process is never described two ways. A `voyage` embedding is remote SaaS;
  either way embedding has a status row and start/stop belongs to whatever
  provides it.
- **The KnowledgeIndex requires a vector store and an embedding model**, so a
  document without either is refused before anything launches: semantic
  search is always available. `semiont start`, `--dry-run` and the `semiont
  init` self-vet read the documents alike, so each enforces it. A `memory`
  vector store is refused with its own explanation: a launcher-managed stack
  runs the Smelter and the Librarian as separate containers, and an
  in-process index cannot be shared across them.
- **The inference and embedding rows list their models.** Which models a stack
  uses is the documents' truth, recorded at start (every model the Inference
  document's engines name, and the embedding's `model`); whether each is pulled
  is verified live against Ollama's `/api/tags` and `/api/ps`, with size,
  parameter count and quantization. A model that was never pulled is
  otherwise invisible until a worker reaches
  for it mid-job and fails, so **`semiont start` pulls them**: after Ollama is
  up it lists what is installed and pulls each configured model that is
  absent, over Ollama's HTTP API (one path for both a host process and the
  launcher's container — no `ollama` CLI needed on PATH). Only models Ollama
  can actually serve are pulled: the `ollama` engines' models plus an ollama
  embedding, never a Claude. If Ollama cannot be listed, NOTHING is pulled —
  unknown is not missing, and re-downloading gigabytes a user already has is
  the worse error. A failed pull warns and leaves the stack running rather
  than aborting it. Status still marks anything absent `MISSING` with the
  `ollama pull` to fix it. **Remote (Anthropic) models get the same treatment
  through `/v1/models`**: while the API key is in hand at start, one GET
  records each configured model's display name, release month, and context
  window — and warns when a model is NOT listed for that key (withdrawn, or a
  typo'd id), the remote analog of MISSING and the only signal before a
  job fails on it. Status renders the recorded metadata, refreshing it live
  only when `ANTHROPIC_API_KEY` is already in its environment — status never
  resolves secrets. NO costs: Anthropic exposes no price list programmatically
  (the pricing page is docs-only; actual spend needs the org-level Admin API,
  a different credential). An unreachable Ollama reads `unknown`, never `missing`: ignorance
  and a finding are different answers. Untagged model names are matched
  against Ollama's `:latest` form. Remote models (Claude, Voyage) list as
  `remote` — there is nothing to install.
  A local Ollama runs only when the documents name ollama — owned by
  inference when an engine uses it, by embedding when only the embedding
  does. Every other container's `image` is its document's — a KB pins or
  upgrades an infra image without a launcher release. `--dry-run` renders
  the derived plan.
- **Model rows carry the platform's discovered ceilings.** The context window
  and output ceiling beside each model come from the KB: the services that
  hold the inference credentials report what their clients discovered from
  each provider (the worker on `job:limits-requested`, the librarian on
  `gather:` and `match:limits-requested`), and status asks each of them over
  the bus, the same requests every other Semiont client makes. The launcher
  asks no provider directly for a ceiling. A shared input+output
  window renders as one figure (`128K window`); distinct ceilings render as
  `200K in / 64K out`, worded as the CollaborationPanel words them so one
  model reads the same in the terminal and in the browser. Where the platform
  publishes a ceiling for a remote model it REPLACES the context figure
  `/v1/models` reported — one number, from one source; that probe keeps
  rendering only what it alone knows. No stack, no session, an unreachable or
  wedged gateway (the request is bounded well under the 30 s a verb waits
  for a reply), or an entry whose discovery failed: the row renders with
  no ceiling and no error. And a ceiling appears only where the
  record can say which provider serves THAT model — a row whose driver says
  `ollama` listing a model Ollama does not serve gets nothing, the same
  per-model-not-per-row rule that keeps a Claude from being checked against
  Ollama. A wrong ceiling would be worse than a missing one.
- KB-root discovery (`SEMIONT_ROOT` is analogous to `GIT_DIR`): the override
  is strict (invalid values error, never fall back), else the root is found
  by walking up from cwd for `.semiont/`. git is not
  part of discovery — the must-be-a-git-clone invariant applies to a full
  start and `--service archivist` (the one service that mounts `/kb`);
  every other service needs at most the `.semiont/` tree. `semiont status`
  reports the root(s) in its KNOWLEDGE BASES section.
- The launcher remembers every root a real start used in `roots.json` (beside
  `stack.json`; entries survive stops, vanished paths are flagged not
  dropped). `semiont start --root <path|name>` selects a root explicitly — a
  directory, or the basename of a registered root — winning over
  `SEMIONT_ROOT` and cwd discovery; the KNOWLEDGE BASES status section
  lists the registry with last-used annotations.
- **`--config` is sticky per KB**: it names the Inference document a start
  runs, `.semiont/stack/inference/<name>.yaml`. `semiont init` records the
  one it wrote on the root's `roots.json` entry, a successful start with an
  explicit `--config` records the name it ran, and `semiont settings config
  <name>` sets it; later starts without the flag use it (banner says
  `Config: anthropic (this KB's recorded config; override with --config)`;
  status shows it under SEMIONT ROOTS). An explicit flag always wins and
  re-records; failed starts and `--dry-run` record nothing, so a typo'd name
  never becomes the default. The preference is per-user-per-machine — which
  Inference document you run depends on your API keys, so it lives in the
  XDG registry, never in the KB repo.
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
  in the launcher's state home ([where](#where-the-launcher-keeps-its-files)).
  `stop` and `status` compute
  their work from those identifiers: they target the recorded runtime by ID,
  skip a host-reused Ollama, and a
  full `stop` forgets the record. No record (another
  machine's stack) falls back to a name sweep of every installed runtime; the record is
  belief — `status` still verifies every claim against the runtime.
- `start`, `stop`, and `status` take `--service <name>` to act on one service
  (named by role: gateway, worker, smelter, weaver, archivist, librarian,
  dispatcher, browser, identity-store, graph, vectors, inference, embedding, traces — the concrete products PostgreSQL,
  Neo4j, Qdrant, Ollama, and Jaeger appear as detail alongside). A `--service` start reads the
  service's own credential from the per-root state a full start persisted —
  nothing is recovered out of a running container — auto-enables OTel iff the collector is up, and stages the
  service's document afresh; a `--service` stop leaves the staged configs in
  place (the rest of the stack still mounts them); a `--service` status exits
  0/1 on that service alone.
- **The images are the documents'**: each service runs the `image` its
  document names, and `semiont init` names `:latest`. An image tagged
  `:local`, built on this machine by `scripts/ci/local-build.sh`, is never
  pulled; a KB runs one by naming it. The Browser, being the machine's, runs
  the image its own document names, `ghcr.io/the-ai-alliance/semiont-browser:latest`
  as the launcher writes it.

### Login and upload

`semiont login` signs in to a running stack's knowledge base through the
issuer it trusts: the launcher reads the KB's OAuth resource metadata, runs
the device authorization grant against that issuer (a URL and a code you
approve in a browser), and stores the tokens per stack in the launcher
state home, mode 0600. No password ever reaches the launcher; a script's
session is the stored refresh token from one interactive sign-in.
`semiont yield --upload <file>` then registers files as KB resources.
Files must live under the KB root (storage URIs are repo-relative; the
content belongs in the repo) — and commit the `.semiont/events/` files an
upload creates: they ARE the documents. Both verbs speak to the gateway
through `packages/go/sdk`, the Go client generated from the same OpenAPI
authority as the TypeScript SDK's types.
Both take `--repo <owner/name>` to target a codespace stack through its
forward instead of the local one.

Sessions maintain themselves: access tokens are short-lived, and every verb's
session is the Go SDK's, which every SDK's session agrees with
(`specs/src/session/cases.json`). At its start it asks the gateway who its
token is; it renews the token invisibly at the issuer from the stored refresh
token when the token has expired or the gateway refuses it (announced on
stderr, kept, retried once); and it forgets a sign-in it cannot renew, so
`semiont login` is the fix only when the renewal itself fails — login is a
rare event, not a routine chore. `semiont logout` ends a session (the refresh
token revoked at the issuer, best-effort; the sign-in forgotten either way,
said plainly when the issuer half didn't complete), and `semiont status
--verbose` lists every stored session under SESSIONS, live-verified against
the stack when reachable — valid / expired / unverified, never a guess.

The stored sessions are the sign-in store, a contract in
`specs/src/sign-in-store`: `<state home>/tokens.json`, which an application
on any SDK reads and renews too, so one `semiont login` serves both. The
launcher keeps it through the Go SDK's store: every change is made under an
exclusive lock on `tokens.lock`, a member it does not understand is written
back as it was, and a file it cannot read is never written over. A renewal
reads the store again before it writes: tokens another program renewed
meanwhile stand, a refresh token another program replaced is not spent, and a
stack signed out meanwhile stays signed out. `semiont login` keeps the state
home to its owner, with everything created in it. The entry's shape, the two
OAuth client ids and the sign-in scope are generated from the spec (`npm run
generate:go`), the state home runs the spec's cases, and CI fails when any of
them drifts.

### Delegating to the stack

Yield and mark each have a hand form and a delegated one. By hand, `semiont
yield --upload` registers a file and `semiont mark <resourceId>` writes one
annotation from a selector and a body. Delegated, the stack's worker does the
work as a job the launcher creates and follows to its end, narrating its
progress:

- `semiont yield --delegate <resourceId> [<annotationId>] --storage-uri
  <uri> --title <text>` gathers context around the resource (or one of its
  annotations) and generates a new resource from it.
- `semiont mark --delegate <resourceId> --motivation <m>` has the worker read
  the whole resource and annotate it: `highlighting`, `commenting`,
  `assessing`, `linking` (references to the entity types `--entity-type`
  names) or `tagging` (a tag schema's categories, `--schema` and
  `--category`). `semiont browse --entity-types` and `semiont browse
  --tag-schemas` list what a KB offers for those. Each motivation's job takes
  its own options: one it does not take is refused before anything is asked,
  with the options it does take.

Each creates a job described by its verb (`jobType` is `mark` or `yield`) and
its parameters, a `mark` job's motivation among them. Both end with what the
job did: the resource generated, or how many annotations were created of how
many were found, in the words of the job's last progress line (`created 3
highlights (4 found)`; comments, assessments, references and tags likewise). A
job the queue runs again after a failed attempt is followed through the retry.
A decline (a resource with no text the worker could read) and a failure both
exit non-zero, and `--json` prints the job's completion as the stack sent it.
A completion is read as its verb's: one that names the
other verb, or reports what the other verb's job reports, is said and exits
non-zero. What `mark --delegate` sends for each motivation is the
`mark.delegate` row of `specs/src/client/surface.json`, which every SDK
runs.

### Searching a KB

`semiont browse` lists and shows what a KB holds; `semiont match` searches
it, in two forms. `semiont match --search <text>` finds resources by text
(`match:resources-requested`; `--entity-type` and `--limit` narrow it, and
`--json` carries the reply's `matchKind`: `lexical` when the text matched,
`semantic` when nothing did and the resources discuss it instead). `semiont
match <resourceId> <annotationId>` finds the resources that annotation could
bind to: it gathers the annotation's context, then runs the scored search
(`match:search-requested`). The two forms exclude each other, and `match`
with neither is refused.

### Giving ids

Each verb that takes ids takes each one by its option or bare, the same way in
every verb:

| Verb | Bare, in this order | By option |
|---|---|---|
| `bind` | `<resourceId> <annotationId> <targetResourceId>` | `--resource`, `--annotation`, `--target`; `--unbind <id>` gives the target to remove |
| `gather` | `<resourceId> [<annotationId>]` | `--resource`, `--annotation` |
| `match` | `<resourceId> <annotationId>` | `--resource`, `--annotation` |
| `yield --delegate` | `<resourceId> [<annotationId>]` | `--resource`, `--annotation` |
| `browse` | `[<resourceId>]` | `--resource` |
| `mark` | `<resourceId>` | `--resource`; `--delete <id>` gives the annotation to delete |
| `beckon` | `<resourceId> [<annotationId>]` | `--resource`, `--annotation` |

The bare ids fill, in order, the places no option filled, so these are one
command:

```bash
semiont bind <resourceId> <annotationId> <targetResourceId>
```

```bash
semiont bind --annotation <annotationId> <resourceId> <targetResourceId>
```

An id given twice, by any two of its options, is refused, and so is a bare word
with no place left.

An id is 1 to 128 letters, digits, `_` and `-`, so it may begin with `-`. An
option's value is read as given, whatever it begins with, but a bare word that
begins with `-` reads as an option. So a bare id that begins with `-` goes
after `--`, which ends the options: every word after it is an id, a flag's name
included.

```bash
semiont bind --json -- <resourceId> -BA3nvXTk3ybl1Qmp_3zZ <targetResourceId>
```

Before `--`, a word that begins with `-` and is none of the verb's options is
refused, and the refusal shows the verb's form with `--`.

### Driving a participant's Browser

`semiont browse <resourceId> --browser` opens that resource on the
PARTICIPANT's screen instead of printing it here — the same act as a plain
`browse`, with a different audience, which is why it is a flag and not a
second verb. It emits `browse:resource-open`, a domain signal the viewer
resolves into its own route; the launcher never learns a URL. `--browser`
refuses to combine with `--json`, `--annotations` or `--entity-types`, since
each of those names a local rendering and the pair would state two
destinations at once.

`semiont browse --annotation <id> --browser` opens **one annotation** the same
way (`browse:click`): the viewer selects that entry in its annotations panel
and scrolls to it. Where a `beckon` only *points*, this *opens* — the two are
distinct moves, not synonyms.

That form takes **no resourceId**, and rejects one rather than ignoring it. An
annotation id names exactly one annotation on exactly one resource, so the id
is the whole address; the wire carries nothing else. Accepting a resourceId
the launcher never sends would hand the caller a second id to keep consistent
for no benefit — and since verifying the pair would need a read this signal
deliberately does not perform, a mismatched pair could only be echoed back as
a lie.

`--annotation` (open one, remotely) sits beside `--annotations` (list them
here). They are one keystroke apart and mean opposite things, so they refuse
each other with a message that says so.

Every emit reports how many subscribers the gateway's target subject had
**at dispatch**, and the verbs say so plainly:

```
✓ Opened res-42 in the Browser (2 subscribers — broadcast, so still no confirmation anyone looked)
✓ Opened annotation ann-9 in the Browser (2 subscribers — broadcast, so still no confirmation anyone looked)
✓ Beckoned toward res-42 (ann-9) — nothing is subscribed to beckon:focus, so no one received it
```

That number is deliberately not called delivery: a subscriber is a connection,
not a pair of eyes, and these channels have no reply. But zero subscribers is a
fact worth saying out loud — `/bus/subscribe` enforces no channel allowlist and
the gateway publishes unconditionally, so without the count an emit into an
empty room would return a clean ✓.

`beckon` exits 0 into an empty room — a beckon is genuinely fire-and-forget,
and an empty room is a fact, not a failure. **`browse --browser` does not,** in
either form. It asked for a specific outcome, something on a participant's
screen, and zero subscribers means that did not happen; a tour script running
under `set -e` should stop rather than narrate on. So it probes the Browser and
says which of three things is true:

```
✗ Nobody saw res-42 — nothing is subscribed to browse:resource-open.
  The Browser is running, but no web browser is watching it.
  Open http://localhost:3000, log in, then run this again.
```

```
✗ Nobody saw res-42 — nothing is subscribed to browse:resource-open.
  No Browser is running on this machine.
  Start it:  semiont browse res-42 --browser --launch
  or:        semiont start --service browser
```

The two failures are independent — the Browser is the Browser *container*,
and what has to be watching it is a human's *web browser* — so the messages
keep those words distinct. A container that exists but is not answering gets
its own third sentence rather than being flattened into either.

The annotation form reports the same three ways, naming what it sent and the
command that retries *it*: `Nobody saw annotation ann-9 — nothing is subscribed
to browse:click`, with `semiont browse --annotation ann-9 --browser --launch`.
A retry line that named the wrong form would be worse than none.

`--launch` starts the Browser when none is running, through the same
`start --service browser` that pulls, publishes the port and waits for health.
It starts a *container*: it cannot open a window or log anyone in, so it still
reports that nobody is watching. Starting one is never implicit — a read verb's
flag does not get to bring a container up as a side effect.

The launcher names an **origin** and never a path. `http://localhost:3000` is
its own fact — it publishes the port the Browser's document names and records
the endpoint — while `/know/resource/<id>` belongs to the Browser, and
mirroring a route here would break silently the day the route moves.
`--browser-url` overrides the recorded origin (precedence: flag → record; with
neither, nothing is probed).

### Watching a KB

`semiont listen` streams the KB's live events. `--json` is line-delimited
— scripts parse it — while the default rendering is meant to be READ:

```
  14:03:12 ● alice@example.com joined  — 1 connection watching
  14:03:20 browse:resource-viewed      resource="The Iliad, Book I"
  14:07:41 ○ alice@example.com left    — 0 connections watching
```

Resource names come from ONE lookup at startup, not one per event, asked on
the stream the events arrive on. Ids the lookup misses render as ids; nothing
blocks and nothing blanks. Presence is counted by CONNECTION, not by person: one human
with two tabs is two connections, and a count keyed on identity would report
one viewer for two and none when the duplicate closed.

The stream is inbound only, and says so on startup — your own `beckon` and
`browse --browser` cues are not echoed back, so silence where a cue should
appear is not evidence the cue failed. `--scope <resourceId>` streams what one
resource's scope carries (its annotations, representations and jobs) in place
of the KB's broadcasts. A stream that drops ends the command: what was
broadcast while it was down is not sent again.

### Serving AI applications over MCP

`semiont mcp` is an MCP server over stdio: an AI application runs it and
reaches every KB this machine has signed in to, as the person `semiont login`
signed in, through the Go SDK. Setting it up is one line,

```bash
claude mcp add semiont -- semiont mcp
```

and [Connecting an AI application](../../docs/builder/AI-APPLICATIONS.md) has
the other clients' form. What the server does that a verb does not:

- **One session for each KB, held across calls.** The KBs are the recorded
  stacks with a stored sign-in (`stack.json`, `tokens.json`); a tool's `kb`
  argument names one by its key, `local:<did-key>` or `codespace:<owner>/<name>`, and
  `kb` goes no further than choosing the client: no request to a gateway
  carries it. A session the SDK reports over ends that call, and the next one
  is refused at once, naming `semiont login`, without asking the issuer again.
- **The tools are a curated set**, named by the verbs, in
  `packages/go/launcher/verbs/mcp-tools.json`, which names the SDK methods each tool calls
  and gives a reason for every method of the client surface no tool calls.
  Each tool's input and output schema is the spec's, made self-contained by
  `scripts/spec/generate-mcp-tools-go.mjs` into `mcp_tools_gen.go`, and CI
  fails when either drifts. `TestMCPToolsCensus` holds the table to
  `specs/src/client/surface.json` both ways.
- **A call is checked before anything is sent**, and a refusal names every
  fault at once: the MCP library's typed tools stop at the first, so each tool
  validates its own call with the JSON Schema library the launcher's documents
  are read with. A refusal is the tool's error, which the model can act on, not
  a protocol error.
- **A delegated job** (`mark_delegate`, `yield_generate`) is followed on the
  job channels the session's stream carries, its progress sent as
  notifications when the client gave a progress token; a cancelled call
  cancels the job. `job_status` answers a job as an MCP task would, and a job
  that is another person's, or that the queue no longer keeps, is unknown.
- **A codespace whose forward is down is said, and nothing is started**: the
  tool answers with `semiont status --repo <owner/name>`, which re-establishes
  a running codespace's forward. The test is the one `semiont status` lists
  active stacks by: the forward's process is the launcher's, and its port
  answers.
- **stdout is the protocol's alone.** Whatever else the process prints goes
  to stderr, where an MCP client keeps its logs. The server answers a
  2026-07-28 client and an older one that initializes alike, on
  `github.com/modelcontextprotocol/go-sdk`.

### Memory ceilings

Every container the launcher runs carries an explicit `--memory` ceiling (no
silent runtime defaults — Apple container would quietly size each
per-container VM at 1G, where a JVM graph or a loaded model dies; docker would
leave it unlimited inside its shared VM). A container a document describes
runs at the `resources.limits.memory` that document states, which `semiont
init` writes from one table in the launcher; Ollama, the telemetry containers
and the Browser run at that table's own
([Configuration](../../docs/operator/administration/CONFIGURATION.md#memory)).
The gateway's capacity follows the ceiling it runs with, and the Smelter
works on the PDFs at once its `pdfsAtOnce` states. The ceilings are visible in
every `--dry-run` line.

On Apple container specifically, ceilings approximate commitments — each one
sizes a VM whose kernel and page cache grow into it — so a live start sums
what it is about to request and **warns with the arithmetic** when the total
crosses 75% of the machine's RAM. A warning, never a refusal: macOS degrades
under pressure (compression, swap) rather than breaking, and the launcher
cannot know what else the host is doing. On docker/podman the sum is quiet by
design: caps are not reservations there, and the runtime's own VM setting is
the real budget.

### Keeping services alive

`semiont start` exits once the stack is up, so nothing outside a container is
left watching it. On a laptop that would mean a service that crashes at 2am
stays dead until you notice.

For **local** runs the launcher therefore sets `SEMIONT_SUPERVISE`, which
starts each service under a small in-container supervisor: it restarts a
crashed process, kills one that stops answering its health endpoint after
having answered it at least once, and gives up rather than looping when a
process dies on boot five times in a row — a deterministic refusal should be
visible, not buried under restarts. A process that boots and then dies within
a minute of its start is crash-looping: each such death says so in the log,
with how it died (a kill under a memory ceiling is almost always running out
of memory), and the next start waits twice as long as the last, up to a
minute. It is not given up on, since it may be making progress between
deaths. `semiont.process.restarts` carries the count, so a service that is
quietly flapping shows up in metrics instead of only in logs.

Every stack the launcher starts gets it, **codespace stacks included**: inside
a codespace, its own launcher starts the stack locally, exactly as on a
laptop. Nor do the images supervise themselves — a container that restarts
its own process never exits, so an orchestrator's restart policy, a Kubernetes
liveness probe or an ECS task policy would all be defeated by it, and a
crash-looping process would read as perfectly healthy from outside.

**The limit worth knowing:** the supervisor restarts a dead *process*, never a
dead *container*. If the runtime or the host VM kills the container itself,
nothing notices until the next `semiont status`. Closing that gap would need
something resident on the host, which the launcher deliberately is not.

### The messaging daemon

A single NATS container, addressed as `--service messaging`, is part of every
stack, and one server carries both drivers the KnowledgeBase's
`spec.messaging` names:

- `jobs.type: jetstream` is the dispatcher's queue (streams plus KV), so the
  daemon runs `-js -sd /data` with a durable state mount. Any other type is
  refused.
- `signal.type: nats` moves the gateway's real-time fan-out onto core NATS
  subjects on the *same* server. Signal frames are never captured — signals are
  not a record — but the gateway's correlation ledger keeps its claims in a
  JetStream KV bucket there, so this driver needs JetStream too.

A broker of your own is stated once, at `spec.messaging.external`, with its
`servers` and the variables holding its user and password: one role is one
daemon. The daemon runs one way — `-js -sd /data` with the state mount —
because both drivers use the store. `semiont status` lists it as
`messaging (NATS)`.

Unlike the Semiont service processes, this is a stock third-party image, so it
is **outside the supervision census above**: nothing restarts it if it stops.
On a broker outage the gateway keeps reading healthy and its emits fail until
the broker returns; the recovery mechanism is to start the container again
(`semiont start --service messaging`, or the runtime directly), after which the
gateway reconnects on its own — no gateway restart. The gateway logs
`[signal BROKER-DOWN]` when the connection drops and `[signal BROKER-RECONNECTED]`
when it returns.

### Where the launcher keeps its files

XDG directories on Linux, and each other system's own equivalent:

| What | macOS | Linux | Windows |
|---|---|---|---|
| **State home**: the stack record (`stack.json`), the registry of knowledge bases and the machine's settings (`roots.json`), sign-ins (`tokens.json`), `discovery/`, and the Browser's and the worker's documents (`stack/browser.yaml`, `stack/workers.yaml`) | `~/Library/Application Support/semiont` | `$XDG_STATE_HOME/semiont` (default `~/.local/state/semiont`) | `%LOCALAPPDATA%\semiont` |
| **Data home**: `roots/<key>/` for each knowledge base, holding its stores and its kept secrets | the state home | `$XDG_DATA_HOME/semiont` (default `~/.local/share/semiont`) | the state home |
| **Log**: `launcher.log` | `~/Library/Logs/semiont` | the state home | `logs\` in the state home |
| **Staging**: the configs a running stack mounts | `/tmp/semiont-config.*` | `/tmp/semiont-config.*` | `%TEMP%\semiont-config.*` |

A knowledge base's `roots/<key>/` holds one directory per store — `postgres/`
(database), `neo4j/` (graph), `qdrant/` (vectors), `nats/` (job queue and
signals), `state/` (views and projections), `anchored-text/`, `gateway/` and
`librarian/` (each service's supervisor's events log) — and `logs/`,
the container logs a start keeps before it removes the containers. Its kept
secrets are files beside them, unless `semiont settings secret-store` names
another store.

This is none of the knowledge base itself, which is its root: the working tree
you start from. `semiont status --verbose`, run from a root, prints that root,
the directory its stores are in, and what each store takes on disk.

### Where state lives

Local-stack databases persist across restarts. Each local semiont root gets
its own directory, `roots/<key>` under the launcher's data home, keyed by the
KB's did:web when `.semiont/config.yaml` declares one (identity travels with the KB, so a moved
clone keeps its state), else by a hash of the root path. `start`
bind-mounts each store's subdir into its container: PostgreSQL rows —
Keycloak's accounts and realms, which the event log does **not** record —
survive `stop` and restart. A `meta.json` stamp records which image wrote each store; a
start whose Issuer document names a *different* database image over existing data
refuses with a fix-it line rather than risk it (Postgres data is never
auto-deleted). Keycloak manages its own schema on first boot; Semiont applies
no migrations of its own, because the gateway keeps no database.

Qdrant (`qdrant/`) and Neo4j (`neo4j/`) state persists the same way, with
the opposite mismatch rule: they are *projections* of the event log, so a
start whose KnowledgeIndex names a different image announces it is clearing the
stale store and lets the normal rebuild repopulate it — freshness by
rebuild, never a refusal. (The Neo4j subdirs are host-side mode 777: its
entrypoint refuses to boot unless its `test -w` gate passes, and Apple
container's virtiofs won't let it chown a mount root.)

The anchored-text store (`anchored-text/`) is a projection with no image stamp,
mounted into the Archivist alone. Each entry carries the stamp of the PDF reader and
the OCR engine that derived it, and is served only under the stamp the Smelter
states, so no image change clears it: an older stamp's entries stay on disk, served
to no one, until `semiont clean --store anchored-text`.

No store is mounted by two containers: under Apple container each container is
its own VM, and a second mounter of a host directory can read a file cut short.
The state tree (`state/`) is the Archivist's alone, and the gateway and the
Librarian each mount a store of their own (`gateway/`, `librarian/`) for their
supervisor's events log, which no image stamps.

`semiont clean` is the one way this state dies: it removes the current
root's state directory (`--store identity-store|vectors|graph|anchored-text|messaging|state|gateway|librarian`
scopes to one
store; `--dry-run` shows what would go, with sizes; `--root <path|name|key>`
targets another root — a literal key is how you remove *orphaned* state
whose KB directory no longer exists). It refuses while a recorded stack is
using the state — stop first. `stop` itself never touches state; stopping
and restarting is exactly the round trip persistence exists for.

**Two homes, not one.** Per-root stores live under the launcher's *data* home.
The machine-level view — the discovery document the Browser mounts — lives
under its *state* home instead. On macOS and Windows the two are one directory,
so `roots/` and `discovery/` sit side by side and the distinction is invisible.
On Linux they are deliberately different trees. `semiont clean` scopes to a
root's data and never touches discovery, which the next stack mutation
regenerates regardless.

## Development

This directory is the program: `main.go`, and the tests that build it and
drive it. Everything else it runs on is its libraries,
[packages/go/launcher](../../packages/go/launcher/README.md).

Build and test both (hermetically — no Go on the host required):

```sh
container run --rm -v "$(pwd)":/work -w /work "golang:$(scripts/ci/go-toolchain.sh)" \
  sh -c "cd apps/launcher && go vet ./... && go test ./... && cd ../../packages/go/launcher && go vet ./... && go test ./..."
```

The tests in `launcher_test.go` are the executable spec: golden files under
`packages/go/launcher/testdata/golden/` pin the exact runtime argv sequences per scenario, and a
fake-runtime binary (`packages/go/launcher/fakert`) impersonates
container/docker/podman/git, and lsof/ps (netstat/tasklist on Windows), on a
private PATH — tests never touch a real runtime. If a behavior change is
intended, adjudicate deliberately (the goldens are the spec), then refresh
them with `go test -run <Test> . -update-goldens`. The goldens are written on
Linux, with placeholders for every host path; a run on macOS or Windows
compares against them as that system runs.

What of the libraries the scenarios reach is measured by the launcher they
run, not by the test binary: `go test . -launcher-coverdir=<dir>` builds that
launcher with coverage of itself and of `packages/go/launcher`, and every run
of it writes there. `go tool covdata percent -i <dir>` reads it, and `go tool covdata
textfmt -i <dir> -o <file>` writes it as a profile. `go test -coverprofile`
cannot hold it, since it reads only what the test binary itself wrote, and a
launcher that ends by a signal writes nothing.

The suite refuses to run when `/tmp/semiont-config.*` exists (a live stack may
be mounting those staged configs, and the launcher's preflight sweeps them) —
stop the stack first, or run the tests in a container.

## Releasing

`launcher-release.yml` runs goreleaser at a release's `vX.Y.Z` tag, dispatched by
`release.yml` once the tag exists ([Release Process](../../docs/contributor/RELEASE.md)):
GitHub Release archives with SBOMs and provenance attestation, plus the Homebrew formula
pushed to `The-AI-Alliance/homebrew-semiont` (needs the `TAP_GITHUB_TOKEN`
secret). No code signing anywhere — brew-installed binaries carry no
quarantine attribute, and channels that would require a signing entity
(macOS .pkg, winget) are deliberately unoffered.
