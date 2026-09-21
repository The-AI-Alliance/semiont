# semiont-dispatcher

**Where a worker asks what to do and reports back.** It owns the job queue and answers the
`job:*` lifecycle commands — claim, progress, checkpoint, complete, fail, cancel, status. It
dispatches and records; it does not perform (that is the [worker](../worker/)).

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-dispatcher` |
| Port | 24105 (`/health`, and nothing else — all real traffic is the bus) |
| Entry point | `@semiont/make-meaning/dist/dispatcher-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## The source is not in this directory

Only the image recipe lives here. The entry point is
`packages/make-meaning/src/dispatcher-main.ts`, and the image installs the published
`@semiont/make-meaning` and runs `dist/dispatcher-main.js` out of it. That is deliberate: the
entry point is thin wiring over the queue it starts, and moving it here would mean promoting
that package's internals to public API to satisfy a directory layout.

Change the CMD only against that file.

## What it is — a control plane, not a conduit

The dispatcher answers questions about *what work is available* and *what a worker has been
assigned*, and records what workers report back. **Content bytes and the resulting annotations
never flow through it.** A worker claims a job here, pulls content from the
[Archivist](../archivist/) over HTTP, writes annotations to the Archivist over the bus, and
tells the dispatcher only that it finished. Routing results back through the dispatcher —
tempting, since it already knows the job — would turn a control plane into a conduit for
knowledge-system content, and it never will.

This is the seam a **foreign** worker walks through: it reaches the dispatcher over the bus
with an HTTP endpoint and a token, and needs nothing else — no broker credential, no KB mount.

## Configuration

Reads `~/.semiontconfig` (TOML), section chosen by `[defaults] environment`. Required:

| Key | |
| --- | --- |
| `services.gateway.publicURL` | the bus it attaches to and answers on |
| `services.identity.issuer` | where it authenticates as a service account |
| `services.jobs.{type,servers}` | the queue backend (JetStream in the deployed fleet) |

Two environment variables:

- **`SEMIONT_OIDC_CLIENT_ID`** / **`SEMIONT_OIDC_CLIENT_SECRET`** — this process's own service
  account at the knowledge base's issuer. It exchanges them for an issuer token, which buys an
  agent token from the gateway.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the queue and this entry point
- [`@semiont/jobs`](../../packages/jobs/) — the `JobQueue` interface and its drivers
- [Worker](../worker/) — the executor, and a client of this service
- [Archivist](../archivist/) — serves the bytes and records the annotations, directly to workers
