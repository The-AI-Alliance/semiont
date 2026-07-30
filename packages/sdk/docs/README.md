# `@semiont/sdk` documentation map

Six documents, each with ONE job. They follow the classic four-quadrant split
(how-to / reference / explanation / contract) plus one orientation doc; knowing
a doc's quadrant tells you what belongs in it — and what to reject in review.

| Doc | Role | One-line scope |
|---|---|---|
| [INTRODUCTION.md](./INTRODUCTION.md) | **Orientation** (read first) | The builder's mental model: the three core ideas, the contract→SDKs→bindings stack, live data, a one-page chat turn, the testing ethos, and the build-vs-adopt case for teams shipping with AI coding tools. No recipes, no reference. |
| [DEVELOPER-GUIDE.md](./DEVELOPER-GUIDE.md) | **How-to** (and the de-facto tutorial) | Task-ordered recipes: connect → ingest → enrich → gather → generate → annotate → react live → test → tear down. Short prose + the exact lines. |
| [Usage.md](./Usage.md) | **Reference** | The per-namespace surface: every method family, options, return shapes, error vocabulary, bus debugging. |
| [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) | **Explanation** | Why the surface is shaped this way: RxJS substrate, the four return shapes, thenable streams vs `.fresh()` live queries, the three paths to the bus. |
| [STATE-UNITS.md](./STATE-UNITS.md) | **Explanation + conventions** | The state-unit pattern (factory closure, RxJS surface, dispose lifecycle, session-typed factories) and the enforced axioms behind it. |
| [CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md) | **Contract** | The live-query cache's numbered behavioral contract (B1–B18): `CacheState` emissions, SWR, bounded retry, failure-as-emission, disposal, persistence. Tests cite these numbers. |

Rules of placement:

- **Concepts a newcomer needs before any code** go in INTRODUCTION — and
  nowhere else, so the mental model is taught in exactly one place. A new
  **recipe** goes in the DEVELOPER-GUIDE; a new **method** goes in Usage.md;
  a new **design rationale** goes in REACTIVE-MODEL or STATE-UNITS; a new
  **cache behavior** gets a B-number in CACHE-SEMANTICS *and* a test citing
  it. If a change doesn't fit one home, it's probably two changes.
- Contract docs (CACHE-SEMANTICS, and the protocol docs below) carry
  **revision logs** — behavior changes append a dated entry.
- **Code fences are compile-checked.** Every ` ```ts `/` ```tsx `/
  ` ```typescript ` fence in these docs is extracted and type-checked against
  the built packages (plus an await-thenable pass) by
  `scripts/compliance/audit-doc-snippets.sh` — CI fails on snippet rot. Names
  a snippet doesn't define come from the ambient prelude at
  [`__snippets__/prelude.ts`](./__snippets__/prelude.ts); extend the prelude
  rather than adding boilerplate to a snippet. Mark a fence ` ```ts no-check `
  ONLY for genuine pseudocode or display-only shapes — exemptions are counted
  and the census should hold flat or shrink.
- Wire-level truth lives OUTSIDE this package, in
  [`docs/protocol/`](../../../docs/protocol/) —
  [TRANSPORT-CONTRACT.md](../../../docs/protocol/TRANSPORT-CONTRACT.md) (what
  every `ITransport` honors), [TRANSPORT-HTTP.md](../../../docs/protocol/TRANSPORT-HTTP.md)
  (SSE wire, subscription matrix, resumption, reply retention),
  [EVENT-BUS.md](../../../docs/protocol/EVENT-BUS.md) and
  [CHANNELS.md](../../../docs/protocol/CHANNELS.md) (channel taxonomy). SDK
  docs LINK there; they don't restate wire format.

## Reading order by audience

**New to Semiont entirely** — [INTRODUCTION.md](./INTRODUCTION.md) first; it
routes you to the right doc by goal.

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
harnesses in `@semiont/core/testing/axioms` are the executable half of these docs
(the test doubles themselves live at `@semiont/core/testing`, free of any
`fast-check` requirement).

## Where the concepts live

The mental model — the eight verbs, the typed return shapes, `CacheState` live
queries, session-owned lifecycle, and the bus's two-tier delivery contract — is
taught once in [INTRODUCTION](./INTRODUCTION.md) and specified in the docs
above. It is deliberately NOT restated here: a map that also teaches is a map
that drifts from the docs it maps.

The canonical order for the eight verbs, used in
[`docs/protocol/flows/`](../../../docs/protocol/flows/) and everywhere that
lists them: **browse · bind · yield · mark · frame · gather · match · beckon**.
