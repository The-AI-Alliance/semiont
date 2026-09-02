# semiont-librarian

**The reference desk.** It searches the collection and hands back what is relevant — ranked
or assembled — for an inquiry that belongs to someone else. It never concludes anything;
concluding is the Generator's job.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-librarian` |
| Port | 9094 |
| Entry point | `@semiont/make-meaning/dist/librarian-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## What it runs

The two LLM-bound actors:

- **Gatherer** — assembles gathered context for annotations (`gather:requested`) and
  resources (`gather:resource-requested`), including semantically similar passages pulled
  from the vector store.
- **Matcher** — context-driven candidate search for the bind flow: multi-source retrieval,
  composite structural scoring, and optional LLM semantic scoring.

Plus the gather-summary handler, which registers here **beside the actor it calls** rather
than in the gateway — the same fact-consumers-follow-the-actor rule the Archivist's
annotation-assembly handler follows.

## What it talks to

The bus (SSE in, `POST /bus/emit` out), Neo4j and Qdrant as the retrieval sources, and an
embedding provider for query embedding.

**It mounts no knowledge base.** Unlike the Archivist it holds no file-backed state — every
byte it needs arrives over the bus or from the two datastores, which is what makes it
independently scalable if retrieval ever becomes the bottleneck.

## Why it is separate from the Archivist

The two are a deliberate pair, and the distinction is the one the professions themselves
draw. **The Archivist preserves and serves unique records; the Librarian helps seekers find
and use material.** Naming them as a pair is also what keeps "Librarian" honest — contrasted
with the Archivist it names one half of a real division of labour, rather than reducing a
whole profession to retrieval.

Practically: these two actors are the LLM-bound ones. Their latency and failure modes are
inference-shaped, not storage-shaped, and keeping them off the record-keeping service means
a slow model never blocks a write.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the actors and this entry point
- [Archivist](../archivist/) — the other half of the pair
- [Gather flow](../../docs/protocol/flows/GATHER.md) · [Match flow](../../docs/protocol/flows/MATCHER.md)
