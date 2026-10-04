# Building with the Semiont SDK

For people, and AI agents, building on Semiont with the SDK: a script, a
daemon, an application, an agent. The examples are TypeScript. The Rust SDK
has the same namespaces, methods and behaviour, and its
[README](../../packages/sdk-rust/README.md) maps each TypeScript shape here to
its Rust form.

Other readers have other homes: building Semiont itself is
[docs/development](../development/README.md), running it is
[docs/system](../system/README.md), and the wire and the contracts every SDK
is held to are [docs/protocol](../protocol/README.md).

Five documents here, each with ONE job, and one contract in
[docs/protocol](../protocol/README.md). They follow the classic four-quadrant split (how-to / reference /
explanation / contract) plus one orientation doc; knowing a doc's quadrant
tells you what belongs in it — and what to reject in review.

| Doc | Role | One-line scope |
|---|---|---|
| [INTRODUCTION.md](./INTRODUCTION.md) | **Orientation** (read first) | The builder's mental model: the three core ideas, the contract→SDKs→bindings stack, live data, a one-page chat turn, the testing ethos, and the build-vs-adopt case for teams shipping with AI coding tools. No recipes, no reference. |
| [DEVELOPER-GUIDE.md](./DEVELOPER-GUIDE.md) | **How-to** (and the de-facto tutorial) | Task-ordered recipes: connect → ingest → enrich → gather → generate → annotate → react live → test → tear down. Short prose + the exact lines. |
| [Usage.md](./Usage.md) | **Reference** | The per-namespace surface: every method family, options, return shapes, error vocabulary, bus debugging. |
| [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) | **Explanation** | Why the surface is shaped this way: RxJS substrate, the four return shapes, thenable streams vs `.fresh()` live queries, the three paths to the bus. |
| [STATE-UNITS.md](./STATE-UNITS.md) | **Explanation + conventions** | The state-unit pattern (factory closure, RxJS surface, dispose lifecycle, session-typed factories) and the enforced axioms behind it. |
| [CACHE-SEMANTICS.md](../protocol/CACHE-SEMANTICS.md) | **Contract** | The live-query cache's numbered behavioral contract: `CacheState` emissions, SWR, bounded retry, failure-as-emission, disposal, persistence. Tests cite these numbers. |

[`skills/`](./skills/) holds the agent skill packs: one ready-made definition per
task, for agentic coding assistants.

## React: embedding `@semiont/react-ui`

[`react-ui/`](./react-ui/) is for a React application that embeds Semiont's
components. Install and setup are in the package's
[README](../../packages/react-ui/README.md).

| Doc | Scope |
|---|---|
| [COMPONENTS.md](./react-ui/COMPONENTS.md) | The component library, by function. |
| [ANNOTATIONS.md](./react-ui/ANNOTATIONS.md) | The annotation components, views and registry. |
| [modal-components.md](./react-ui/modal-components.md) | The search and resource-selection modals. |
| [navigation-components.md](./react-ui/navigation-components.md) | The sidebar and menu navigation. |
| [API-INTEGRATION.md](./react-ui/API-INTEGRATION.md) | Getting the client, reading and writing data, events and errors from React. |
| [ROUTING.md](./react-ui/ROUTING.md) | The `Link` and `routes` the host application supplies. |
| [INTERNATIONALIZATION.md](./react-ui/INTERNATIONALIZATION.md) | `TranslationProvider`, with the built-in locales or your own. |
| [ACCESSIBILITY.md](./react-ui/ACCESSIBILITY.md) | What the components provide for WCAG 2.1 AA, and the hooks. |
| [FAVICON.md](./react-ui/FAVICON.md) | The branded favicon set. |
| [CSS-SOURCE-MAPS.md](./react-ui/CSS-SOURCE-MAPS.md) | Debugging the pre-built CSS. |
| [STYLES.md](./react-ui/STYLES.md) | Importing the styles, the design tokens, and the classes the components use. |
| [SESSION.md](./react-ui/SESSION.md) | The session classes, the two buses, and the provider and hooks. |
| [EVENTS.md](./react-ui/EVENTS.md) | Subscribing and emitting from React, and reading the wire log. |
| [TESTING.md](./react-ui/TESTING.md) | The test utilities and how to test with them. |

How react-ui is built inside is in
[`packages/react-ui/docs`](../../packages/react-ui/docs/), including the
internals behind the last four.

## Rules of placement

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
  [`tests/doc-snippets/prelude.ts`](../../tests/doc-snippets/prelude.ts); extend the prelude
  rather than adding boilerplate to a snippet. Mark a fence ` ```ts sketch `
  ONLY for genuine pseudocode or display-only shapes — exemptions are counted
  and the census should hold flat or shrink.
- Wire-level truth lives OUTSIDE this directory, in
  [`docs/protocol/`](../protocol/) —
  [TRANSPORT-CONTRACT.md](../protocol/TRANSPORT-CONTRACT.md) (what
  every `ITransport` honors), [TRANSPORT-HTTP.md](../protocol/TRANSPORT-HTTP.md)
  (SSE wire, subscription matrix, resumption, reply retention),
  [EVENT-BUS.md](../protocol/EVENT-BUS.md) and
  [CHANNELS.md](../protocol/CHANNELS.md) (channel taxonomy). These
  docs LINK there; they don't restate wire format.

## Reading order by audience

**New to Semiont entirely** — [INTRODUCTION.md](./INTRODUCTION.md) first; it
routes you to the right doc by goal.

**"I want to call the API from a script"** —
the SDK's [README](../../packages/sdk/README.md) § Install & connect, then DEVELOPER-GUIDE recipes 1–10.
You never need the other docs.

**"I'm building an app on it (browser, TUI, daemon)"** —
DEVELOPER-GUIDE end to end, then Usage.md as the lookup reference, then
REACTIVE-MODEL § "What this looks like at the call site" and § "Three paths
to the bus". Add STATE-UNITS when your app grows coordinated page/flow state.
Write tests with [`@semiont/sdk/testing`](./DEVELOPER-GUIDE.md#testing-your-consumer--semiontsdktesting)
from day one.

**"I'm building in Rust"** — INTRODUCTION for the model, then the Rust SDK's
[README](../../packages/sdk-rust/README.md): its three ways to use the client, and the
table that maps each TypeScript shape in these docs to its Rust form.
[`semiont-http-transport`](../../packages/http-transport-rust/README.md) has the
sessions and signing in. CACHE-SEMANTICS and STATE-UNITS are contracts of both
SDKs: the Rust tests cite the same clause numbers.

**"I'm an AI agent, or building one"** — the
[skill packs](skills/) are ready-made definitions for agentic
coding assistants, one per task, and each cites the reference here. Read
INTRODUCTION for the model first; its § "Could your coding agent just build
this?" is addressed to you. A human and an agent use the same client and the
same verbs: nothing in these docs is for one and not the other.

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
[`docs/protocol/flows/`](../protocol/flows/) and everywhere that
lists them: **browse · bind · yield · mark · frame · gather · match · beckon**.
