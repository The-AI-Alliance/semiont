# Semiont Protocol

Semiont is infrastructure for **collaborative knowledge work** — humans and AI agents working as peers on a shared corpus, possibly across rooms or cities, possibly across time. The protocol is the contract that makes that collaboration possible: a uniform set of **eight composable flows** — frame, yield, mark, match, bind, gather, browse, beckon — that every participant speaks, regardless of whether they're a person reading a document in a browser, an AI agent proposing references, a script ingesting new sources, or a daemon worker doing background analysis. Anything that conforms to the protocol can act as a peer; the knowledge base does not distinguish between humans and AI agents.

Knowledge work isn't only data processing. It's interpretation, attention, debate, framing, citation — actions that depend on knowing what your collaborators are doing and why. Semiont's protocol is shaped accordingly: alongside the CRUD-shaped flows there are first-class **collaboration primitives** (`beckon:hover`, `mark:shape-changed`, `bind:initiate`, ...) that let participants observe each other's intent and attention as it happens. Multi-participant coordination isn't bolted on top of a data-processing API — it's woven into the protocol from the bottom.

This page covers the design tenets, the value proposition, and the three programmable surfaces (CLI, SDK, Skills) every participant uses.

For the deeper specifications, see:
- **[flows/README.md](flows/README.md)** — per-flow contracts (frame, yield, mark, match, bind, gather, browse, beckon)
- **[EVENT-BUS.md](EVENT-BUS.md)** — wire-level event protocol: channel naming, `correlationId` / `_userId` conventions, `_trace` carrier, gateway injection, resource scoping
- **[CHANNELS.md](CHANNELS.md)** — channel inventory: persisted events, ephemeral signals, correlation responses, resource broadcasts
- **[TRANSPORT-CONTRACT.md](TRANSPORT-CONTRACT.md)** — abstract `ITransport` behavioral guarantees every transport must honor
- **[TRANSPORT-HTTP.md](TRANSPORT-HTTP.md)** — HTTP+SSE wire format
- **[API.md](API.md)** — REST endpoint reference
- **[W3C-WEB-ANNOTATION.md](W3C-WEB-ANNOTATION.md)** + **[W3C-SELECTORS.md](W3C-SELECTORS.md)** — W3C compliance story

## Why Semiont

Semiont transforms unstructured content into interconnected semantic networks, stored as portable, structured annotations anchored to source passages. Self-hosted, so your data stays on your infrastructure. Inference runs on **Anthropic** (cloud) or **Ollama** (local) — mix providers per worker to balance cost, capability, and privacy.

**Eliminate Cold Starts** — Import a set of documents and the eight flows immediately begin producing value: AI agents detect entity mentions, propose annotations, and generate linked resources while humans review, correct, and extend the results. The knowledge graph grows as a byproduct of annotation — no upfront schema design, manual data entry, or batch ETL pipeline required.

**Calibrate the Human–AI Mix** — Because humans and AI agents share identical interfaces, organizations can dial the mix to fit their constraints. A domain with abundant expert availability and a high accuracy bar can run human-primary workflows with AI suggestions; a domain rich in GPU capacity but short on specialists can run agent-primary pipelines with human spot-checks. Supervision depth, automation ratio, and quality gates are deployment decisions — not architectural rewrites.

**Coordinate Across Participants** — A room of analysts working with three AI agents on a multimodal corpus needs more than synchronized state. They need to see who's currently looking at what, who's proposing a binding, what an agent is sparkling as a candidate match. Semiont treats those signals as protocol-level events on the shared bus, not local UI state — so a participant in another city, a worker across an SSE connection, or an agent running in-process all see them and can react.

## Core Tenets

**Peer Collaboration** — Humans and AI agents are architectural equals. Every operation — read, write, **and coordination signal** — flows through the same API, event bus, and event-sourced storage regardless of who initiates it. Any workflow can be performed manually, automated by an agent, or done collaboratively, in any mix and at any scale.

**Document-Grounded Knowledge** — Knowledge is always anchored to source documents. Annotations point into specific passages; references link documents to each other. The knowledge graph is a projection of these grounded relationships, not a replacement for the original material.

**Coordination is First-Class** — `beckon:hover`, `mark:shape-changed`, `bind:initiate`, `browse:click` and the rest of the collaboration signals fan out to every connected participant. They aren't browser-app UI noise — they're how multi-participant work stays coherent. A human's hover can drive an agent's relevance scoring; an agent's sparkle can direct a human's attention. The protocol exposes them at the same level as data operations.

**[Eight Collaborative Flows](flows/README.md)** — humans and AI agents work as peers through eight composable workflows:

- **[Frame](flows/FRAME.md)** — Define and evolve the KB's schema vocabulary — what *kinds* of things exist (entity types, future tag schemas, relation types). The schema layer the other seven flows operate within
- **[Yield](flows/YIELD.md)** — Introduce new resources into the system — upload documents, load pages, or generate new content from annotated references
- **[Mark](flows/MARK.md)** — Add structured metadata to resources — highlights, assessments, comments, tags, and entity references — manually or via AI-assisted detection
- **[Match](flows/MATCHER.md)** — Search the knowledge base for candidate resources using multi-source retrieval and composite scoring — structural signals plus optional LLM re-ranking
- **[Bind](flows/BIND.md)** — Resolve ambiguous references to specific resources, linking entity mentions to their correct targets in the knowledge base
- **[Gather](flows/GATHER.md)** — Assemble related context around a focal annotation for downstream generation or analysis
- **[Browse](flows/BROWSE.md)** — Navigate through resources, panels, and views — structured paths for reviewing and examining content
- **[Beckon](flows/BECKON.md)** — Direct user focus to specific annotations or regions of interest through visual cues and coordination signals

The eight flows are also the eight verb namespaces on the SDK's `SemiontClient` (`client.frame.X(...)`, `client.yield.X(...)`, `client.mark.X(...)`, `client.match.X(...)`, ...). The protocol's vocabulary and the typed namespace surface are 1:1 — learn the flows once, read the SDK with no further translation. The collaboration signals from "Coordination is First-Class" appear on the same namespaces as `void`-returning methods (`beckon.hover`, `mark.changeShape`, `bind.initiate`, `browse.click`); see [`packages/sdk/README.md`](../../packages/sdk/README.md#three-ideas-that-hold-the-surface-together) for the SDK-side framing.

## Automate

Every operation in the GUI is available programmatically. The same eight flows work identically whether driven by a human, a script, or an AI agent.

**[Semiont CLI](../../apps/cli/README.md)** — pipe the full annotation pipeline from the terminal:

```bash
semiont mark doc-123 --delegate --motivation linking --entity-type Person --entity-type Organization
semiont gather annotation doc-123 ann-456
semiont match doc-123 ann-456
semiont bind doc-123 ann-456 target-789
```

**[Semiont SDK](../../packages/sdk/README.md)** — type-safe TypeScript SDK organized by the eight verbs. `SemiontClient.signInHttp(...)` is the credentials-first one-line construction for scripts. Long-running scripts that span token expiry use `SemiontSession.signInHttp(...)` instead — same shape, plus refresh and persistence.

The SDK is RxJS-native — live queries and progress streams are real Observables — but its return values implement `PromiseLike<T>`, so `await semiont.X.Y(...)` works directly without learning RxJS. Reach for `.subscribe(...)` only when you want progress events or live updates, and `.pipe(...)` only when you want operator composition. The deeper guides live alongside the package: **[Usage.md](../../packages/sdk/docs/Usage.md)** is the per-namespace tour, **[REACTIVE-MODEL.md](../../packages/sdk/docs/REACTIVE-MODEL.md)** explains the Promise-shape-over-Observable design, and **[CACHE-SEMANTICS.md](../../packages/sdk/docs/CACHE-SEMANTICS.md)** is the live-query cache contract.

```typescript
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({ baseUrl: 'http://localhost:4000', email, password });

await semiont.mark.assist(resourceId, 'linking', { entityTypes: ['Person'] });
const context = await semiont.gather.annotation(annId, resourceId);
const results = await semiont.match.search(resourceId, refId, context);
await semiont.bind.body(resourceId, annId, [{ op: 'add', item: { type: 'SpecificResource', source: targetId } }]);
```

**[Agent Skills](skills/)** — ready-made skill definitions that agentic coding assistants like Claude Code can use to drive the full pipeline without writing integration code.

See the **[Local Semiont Overview](../system/LOCAL-SEMIONT.md)** for alternative setup paths.
