# semiont-weaver

**Projects the event log into the graph.** One of the two projection pipelines — the graph
half of what the Smelter does for vectors.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-weaver` |
| Port | 24102 (`/health`, and nothing else — all real traffic is the bus) |
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

The image also bundles `neo4j-driver`, as the Librarian's does and the Archivist's and the
Smelter's do not. It is a lazy peer of `@semiont/graph`, loaded at connect time, so only the
images of services that dial the graph carry it. The Weaver is the one that writes it.

## What it does

Subscribes to graph-relevant domain events over SSE and writes them into the graph store:
resources, annotations, references, entity types, and the edges between them. That projection
is what `gather.referencedBy` answers from, and what gather's knowledge-graph traversal
walks.

It is a pure network peer. Its only privileged attachment beyond the bus is the graph
database — no knowledge base mount, no event-store attachment. Even the history it replays
arrives as `browse:*` bus reads.

## Readers wait on its signals

Every apply emits `weave:applied` with the resource and the sequence it has reached. The
Archivist and the Librarian each fold those into per-resource progress, and the
read-after-write barrier in gather's knowledge-graph build waits on that signal rather than
polling.

So a stopped weaver is not a quiet degradation. Reads that need a just-written node block at
the barrier and then fail — the graph stays empty, and a gather finds nothing to walk.

`weave:rebuild` is the one command it accepts: optionally scoped to a single resource,
strictly serialized, answered with a correlated `weave:rebuild-ok` or `weave:rebuild-failed`.
A rebuild that dropped events fails rather than claiming success.

## Configuration

Reads `~/.semiontconfig` (TOML), section chosen by `[defaults] environment`. Required:

| Key | |
| --- | --- |
| `services.gateway.publicURL` | the bus it subscribes to and emits on |
| `services.graph.type` | the graph sink — must be server-backed |
| `services.identity.issuer` | where it signs in |

Those are the three sections it reads: `gateway`, `graph` and `identity`.
`type = "memory"` is refused at startup: the in-memory graph lives in one process's heap and
cannot be shared with the Archivist and the Librarian, which read it.

Its environment is **`SEMIONT_OIDC_CLIENT_ID`** / **`SEMIONT_OIDC_CLIENT_SECRET`**: its own
service account at the knowledge base's issuer, exchanged for an issuer token and then for an
agent token naming the stable identity `(semiont, weaver)`:
`did:web:<the knowledge base's domain>:agents:semiont:weaver`.

It mounts nothing. Its catch-up checkpoint is a file in the container's own temporary
directory, so it lasts as long as the container does. The checkpoint is an optimization, never
a correctness input: losing it degrades the next catch-up to a full replay.

## Startup catch-up and reconcile

On boot it runs two passes. Both are idempotent, so a restart re-runs them, and `/health`
reports each one's phase and summary.

**Catch-up** replays what it missed while down, from the checkpoint forward (full replay if
the checkpoint is gone). **Reconcile** then diffs the projection against what the views serve
and heals divergence from the log — the backstop for damage the accounting cannot witness: a
wiped graph volume, an out-of-band mutation.

**A failed pass does not kill the process.** Under no restart policy an exit means gone
until a human notices, and one refused bus request is enough to fail a pass. A failed repair
pass is a data condition, so the weaver
survives it and logs an error. That error is the only operator-visible signal that the
projection may be stale; nothing else reports it, and `/health` does not fold it in.

So a restart heals missed events and drift. **It does not re-derive events it has already
applied.** Reconcile compares a fixed set of facts — node presence, archived flag, entity
types, the annotation id set, and annotation bodies — so a change to what the projection
*stores* outside that set, such as a new denormalized property on a node, is invisible to it.
After that kind of change, run `weave:rebuild`, and verify the projection actually carries
what you expect rather than trusting the command's success line.

**An orphaned view is reported, not healed.** A resource in the catalog whose log holds no
events cannot be rebuilt — replaying nothing writes nothing — so reconcile counts it as
`orphaned` rather than `healed` and warns with the remedy. It means history was rewritten
without invalidating the views; the archivist's startup rebuild reaps such views, and
`semiont clean --store state` clears them outright.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the pipeline and this entry point
- [`@semiont/graph`](../../packages/graph/) — the store adapters and the annotation codec
- [Gateway](../gateway/) — the bus it rides
- [Librarian](../librarian/) and [Archivist](../archivist/) — the readers whose barriers wait on
  its signals
- [Smelter](../smelter/) — the other projection pipeline: same shape, vectors instead of graph
