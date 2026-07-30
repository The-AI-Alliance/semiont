# `@semiont/sdk` documentation map

Five documents, each with ONE job. They follow the classic four-quadrant split
(how-to / reference / explanation / contract); knowing a doc's quadrant tells
you what belongs in it — and what to reject in review.

| Doc | Role | One-line scope |
|---|---|---|
| [DEVELOPER-GUIDE.md](./DEVELOPER-GUIDE.md) | **How-to** (and the de-facto tutorial) | Task-ordered recipes: connect → ingest → enrich → gather → generate → annotate → react live → test → tear down. Short prose + the exact lines. |
| [Usage.md](./Usage.md) | **Reference** | The per-namespace surface: every method family, options, return shapes, error vocabulary, bus debugging. |
| [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) | **Explanation** | Why the surface is shaped this way: RxJS substrate, the four return shapes, thenable streams vs `.fresh()` live queries, the three paths to the bus. |
| [STATE-UNITS.md](./STATE-UNITS.md) | **Explanation + conventions** | The state-unit pattern (factory closure, RxJS surface, dispose lifecycle, session-typed factories) and the enforced axioms behind it. |
| [CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md) | **Contract** | The live-query cache's numbered behavioral contract (B1–B18): `CacheState` emissions, SWR, bounded retry, failure-as-emission, disposal, persistence. Tests cite these numbers. |

Rules of placement:

- A new **recipe** goes in the DEVELOPER-GUIDE; a new **method** goes in
  Usage.md; a new **design rationale** goes in REACTIVE-MODEL or STATE-UNITS;
  a new **cache behavior** gets a B-number in CACHE-SEMANTICS *and* a test
  citing it. If a change doesn't fit one home, it's probably two changes.
- Contract docs (CACHE-SEMANTICS, and the protocol docs below) carry
  **revision logs** — behavior changes append a dated entry.
- Wire-level truth lives OUTSIDE this package, in
  [`docs/protocol/`](../../../docs/protocol/) —
  [TRANSPORT-CONTRACT.md](../../../docs/protocol/TRANSPORT-CONTRACT.md) (what
  every `ITransport` honors), [TRANSPORT-HTTP.md](../../../docs/protocol/TRANSPORT-HTTP.md)
  (SSE wire, subscription matrix, resumption, reply retention),
  [EVENT-BUS.md](../../../docs/protocol/EVENT-BUS.md) and
  [CHANNELS.md](../../../docs/protocol/CHANNELS.md) (channel taxonomy). SDK
  docs LINK there; they don't restate wire format.

## Reading order by audience

**"I want to call the API from a script"** —
[README](../README.md) § Install & connect, then DEVELOPER-GUIDE recipes 1–10.
You never need the other docs.

**"I'm building an app on it (browser, TUI, daemon)"** —
DEVELOPER-GUIDE end to end, then Usage.md as the lookup reference, then
REACTIVE-MODEL § "What this looks like at the call site" and § "Three paths
to the bus". Add STATE-UNITS when your app grows coordinated page/flow state.
Write tests with [`@semiont/sdk/testing`](./DEVELOPER-GUIDE.md#testing-your-consumer--semiontsdktesting)
from day one.

**"I'm changing the SDK itself"** —
REACTIVE-MODEL and STATE-UNITS first (the design constraints your change must
fit), CACHE-SEMANTICS before touching anything the cache backs, and the
protocol docs before touching anything on the wire. The axiom/liveness
harnesses in `@semiont/core/testing` are the executable half of these docs.

## The five ideas everything else hangs off

1. **Eight verbs** — every operation belongs to a flow namespace
   (`browse`, `mark`, `yield`, `gather`, `match`, `bind`, `frame`, `beckon`).
2. **Typed return shapes** — `Promise` / awaitable streams /
   `CacheObservable` (+`.fresh()`) / `void` signals; the shape tells you how
   to consume.
3. **`CacheState` live queries** — subscribe and you get
   `pending | ready | failed` states, kept live by scope-by-observation;
   failure is in-band and recovery is a fresh subscribe.
4. **Sessions own lifecycle** — token refresh, storage, disposal;
   session-scoped state units take the `SemiontSession`, not a bare client.
5. **The bus is the substrate** — commands, replies, and collaboration
   signals all ride one connection with delivery guarantees documented at the
   protocol layer (resumption per scope, reply retention, exactly-once across
   handovers).
