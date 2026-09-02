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

Only the image recipe lives in this directory; the entry-point source is
[`librarian-main.ts`](../../packages/make-meaning/src/librarian-main.ts).

## What it runs

The two LLM-bound actors:

- **Gatherer** — assembles gathered context for annotations (`gather:requested`) and
  resources (`gather:resource-requested`), including semantically similar passages pulled
  from the vector store.
- **Matcher** — context-driven candidate search for the bind flow: multi-source retrieval,
  composite structural scoring, and optional LLM semantic scoring.

Plus the gather-summary handler, which registers here beside the actor it calls rather than
in the gateway — the same fact-consumers-follow-the-actor rule the Archivist's
annotation-assembly handler follows.

## What it talks to

- **The gateway** — agent auth, then the bus: SSE in, `POST /bus/emit` out. Requests arrive
  and replies leave this way; nothing dials the Librarian (its only HTTP route is
  `/health`).
- **The Archivist** — content bytes, fetched on demand during gather. Bytes ride the byte
  path; this process never opens the working tree.
- **Neo4j and Qdrant** — the retrieval sources.
- **An embedding provider** (query embedding) and **per-actor inference clients**
  (Gatherer and Matcher each resolve their own from `actors.*` config).

The `weave:applied` / `smelt:settled` progress signals arrive over the same SSE feed and
drive local folds, so the graph-lag grace and the vector settle barrier behave exactly as
they did in-process.

## What it owns on disk

Nothing. It appends no events, serves no bytes, and never mounts the KB tree. Its one
filesystem read is the materialized views the Archivist maintains, through the shared state
mount — read-only, never rebuilt here — located by the `[kb] name` in the staged config.
The whole environment contract is two variables: `SEMIONT_WORKER_SECRET` (agent auth) and
`XDG_STATE_HOME` (the shared state mount).

## Why it is separate from the Archivist

The two are a deliberate pair: the Archivist preserves and serves unique records; the
Librarian helps seekers find and use material. These two actors are the LLM-bound ones —
their latency and failure modes are inference-shaped, not storage-shaped — so a slow model
never blocks a write, and retrieval capacity scales with request volume while the Archivist
scales with corpus.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the actors and this entry point
- [Archivist](../archivist/) — the other half of the pair: it holds the record and answers
  *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Gather flow](../../docs/protocol/flows/GATHER.md) · [Match flow](../../docs/protocol/flows/MATCHER.md)
