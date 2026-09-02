# semiont-weaver

**Projects the event log into the graph.** One of the two projection pipelines — addressed by
no one, replying to nothing.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-weaver` |
| Port | 9092 |
| Entry point | `@semiont/make-meaning/dist/weaver-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## What it does

Subscribes to graph-relevant domain events and writes them into Neo4j: resources,
annotations, references, entity types, and the edges between them. That projection is what
`browse:referenced-by` and path search read.

## The rebuild is explicit, and that matters

Materialized views rematerialize at startup, so a restart is enough for them. **The graph
does not.** It rebuilds only on an explicit `weave:rebuild` command.

So after a change to what the graph projection *stores*, a stack that restarts but skips the
rebuild serves the **old shape** from the graph while views serve the new one — including any
flat copy the graph denormalizes for query. Re-run the rebuild, and verify the projection
actually carries what you expect rather than trusting the command's success line.

## A pure network peer

Its only privileged attachment beyond the bus is the graph database. Events and rebuild
commands arrive over SSE; history reads (`browse:*`) and `weave:applied` signals ride the same
bus. It mounts no knowledge base and holds no file-backed state.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the pipeline and this entry point
- [`@semiont/graph`](../../packages/graph/) — the store adapters and the annotation codec
- [Smelter](../smelter/) — the other projection pipeline: same shape, vectors instead of graph
