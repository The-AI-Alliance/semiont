# semiont-weaver

**Projects the event log into the graph.** One of the two projection pipelines — the graph
half of what the Smelter does for vectors.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-weaver` |
| Port | 9092 (`/health`, and nothing else — all real traffic is the bus) |
| Entry point | `@semiont/make-meaning/dist/weaver-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## The source is not in this directory

Only the image recipe lives here. The entry point is
`packages/make-meaning/src/weaver-main.ts`, and the image installs the published
`@semiont/make-meaning` and runs `dist/weaver-main.js` out of it. That is deliberate: the
entry point is thin wiring over the pipeline it starts, and moving it here would mean
promoting ~18 of that package's internals to public API to satisfy a directory layout.

Change the CMD only against that file.

The image also bundles `neo4j-driver`, which the Smelter's does not. It is a lazy peer of
`@semiont/graph`, loaded at connect time, and the weaver is the one make-meaning entry point
that actually dials the graph.

## What it does

Subscribes to graph-relevant domain events over SSE and writes them into the graph store:
resources, annotations, references, entity types, and the edges between them. That projection
is what `browse:referenced-by` answers from, and what gather's knowledge-graph traversal
walks.

It is a pure network peer. Its only privileged attachment beyond the bus is the graph
database — no knowledge base mount, no event-store attachment. Even the history it replays
arrives as `browse:*` bus reads.

## Readers wait on its signals

Every apply emits `weave:applied` with the resource and the sequence it has reached. The
gateway folds those into per-resource progress, and the read-after-write barrier in gather's
knowledge-graph build waits on that signal rather than polling.

So a stopped weaver is not a quiet degradation. Reads that need a just-written node block at
the barrier and then fail — the graph stays empty, and gathers 404.

`weave:rebuild` is the one command it accepts: optionally scoped to a single resource,
strictly serialized, answered with a correlated `weave:rebuild-ok` or `weave:rebuild-failed`.
A rebuild that dropped events fails rather than claiming success.

## Configuration

Reads `~/.semiontconfig` (TOML), section chosen by `[defaults] environment`. Required:

| Key | |
| --- | --- |
| `services.gateway.publicURL` | the bus it subscribes to and emits on |
| `services.graph.type` | the graph sink — must be server-backed |

`type = "memory"` is refused at startup: the in-memory graph lives in one process's heap and
cannot be shared with the gateway's readers.

Two environment variables:

- **`SEMIONT_WORKER_SECRET`** — JWT auth with the knowledge system. It authenticates as the
  stable identity `(semiont, weaver)` — `did:web:<host>:agents:semiont:weaver`.
- **`XDG_STATE_HOME`** — where the catch-up checkpoint is written (default `~/.local/state`).
  The checkpoint is an optimization, never a correctness input: losing it degrades the next
  catch-up to a full replay.

## Startup catch-up and reconcile

On boot it runs two passes, both fatal on failure — a weaver that cannot catch up is
projecting a graph of unknown freshness. Both are idempotent, so a restart re-runs them, and
`/health` reports each one's phase and summary.

**Catch-up** replays what it missed while down, from the checkpoint forward (full replay if
the checkpoint is gone). **Reconcile** then diffs the projection against what the views serve
and heals divergence from the log — the backstop for damage the accounting cannot witness: a
wiped graph volume, an out-of-band mutation.

So a restart heals missed events and drift. **It does not re-derive events it has already
applied.** Reconcile compares a fixed set of facts — node presence, archived flag, entity
types, the annotation id set, and annotation bodies — so a change to what the projection
*stores* outside that set, such as a new denormalized property on a node, is invisible to it.
After that kind of change, run `weave:rebuild`, and verify the projection actually carries
what you expect rather than trusting the command's success line.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the pipeline and this entry point
- [`@semiont/graph`](../../packages/graph/) — the store adapters and the annotation codec
- [Gateway](../gateway/) — the bus it rides, and the reader whose barrier waits on its signals
- [Smelter](../smelter/) — the other projection pipeline: same shape, vectors instead of graph
