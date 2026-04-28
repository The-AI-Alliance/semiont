# Semiont Protocol

The protocol is the contract between actors and the knowledge base. It defines **seven composable flows** — yield, mark, match, bind, gather, browse, beckon — that are the same verbs whether driven by a human in the browser, a script using the SDK, an agentic coding assistant, or a daemon worker. Anything that conforms to the protocol can act as a peer; the knowledge base does not distinguish between humans and AI agents.

This page covers the design tenets behind the protocol, the value proposition, and the three programmable surfaces (CLI, SDK, Skills) that drive it.

For the deeper specifications, see:
- **[flows/README.md](flows/README.md)** — per-flow contracts (yield, mark, match, bind, gather, browse, beckon)
- **[EVENT-BUS.md](EVENT-BUS.md)** — wire-level event protocol: channel naming, `correlationId` / `_userId` conventions, `_trace` carrier, gateway injection, resource scoping
- **[CHANNELS.md](CHANNELS.md)** — channel inventory: persisted events, ephemeral signals, correlation responses, resource broadcasts
- **[TRANSPORT-CONTRACT.md](TRANSPORT-CONTRACT.md)** — abstract `ITransport` behavioral guarantees every transport must honor
- **[TRANSPORT-HTTP.md](TRANSPORT-HTTP.md)** — HTTP+SSE wire format
- **[API.md](API.md)** — REST endpoint reference
- **[W3C-WEB-ANNOTATION.md](W3C-WEB-ANNOTATION.md)** + **[W3C-SELECTORS.md](W3C-SELECTORS.md)** — W3C compliance story

## Why Semiont

Semiont transforms unstructured content into interconnected semantic networks, stored as portable, structured annotations anchored to source passages. Self-hosted, so your data stays on your infrastructure. Inference runs on **Anthropic** (cloud) or **Ollama** (local) — mix providers per worker to balance cost, capability, and privacy.

**Eliminate Cold Starts** — Import a set of documents and the seven flows immediately begin producing value: AI agents detect entity mentions, propose annotations, and generate linked resources while humans review, correct, and extend the results. The knowledge graph grows as a byproduct of annotation — no upfront schema design, manual data entry, or batch ETL pipeline required.

**Calibrate the Human–AI Mix** — Because humans and AI agents share identical interfaces, organizations can dial the mix to fit their constraints. A domain with abundant expert availability and a high accuracy bar can run human-primary workflows with AI suggestions; a domain rich in GPU capacity but short on specialists can run agent-primary pipelines with human spot-checks. Supervision depth, automation ratio, and quality gates are deployment decisions — not architectural rewrites.

## Core Tenets

**Peer Collaboration** — Humans and AI agents are architectural equals. Every operation flows through the same API, event bus, and event-sourced storage regardless of who initiates it. Any workflow can be performed manually, automated by an agent, or done collaboratively.

**Document-Grounded Knowledge** — Knowledge is always anchored to source documents. Annotations point into specific passages; references link documents to each other. The knowledge graph is a projection of these grounded relationships, not a replacement for the original material.

**[Seven Collaborative Flows](flows/README.md)** — humans and AI agents work as peers through seven composable workflows:

- **[Yield](flows/YIELD.md)** — Introduce new resources into the system — upload documents, load pages, or generate new content from annotated references
- **[Mark](flows/MARK.md)** — Add structured metadata to resources — highlights, assessments, comments, tags, and entity references — manually or via AI-assisted detection
- **[Match](flows/MATCHER.md)** — Search the knowledge base for candidate resources using multi-source retrieval and composite scoring — structural signals plus optional LLM re-ranking
- **[Bind](flows/BIND.md)** — Resolve ambiguous references to specific resources, linking entity mentions to their correct targets in the knowledge base
- **[Gather](flows/GATHER.md)** — Assemble related context around a focal annotation for downstream generation or analysis
- **[Browse](flows/BROWSE.md)** — Navigate through resources, panels, and views — structured paths for reviewing and examining content
- **[Beckon](flows/BECKON.md)** — Direct user focus to specific annotations or regions of interest through visual cues and coordination signals

## Automate

Every operation in the GUI is available programmatically. The same seven flows work identically whether driven by a human, a script, or an AI agent.

**[Semiont CLI](../../apps/cli/README.md)** — pipe the full annotation pipeline from the terminal:

```bash
semiont mark doc-123 --delegate --motivation linking --entity-type Person --entity-type Organization
semiont gather annotation doc-123 ann-456
semiont match doc-123 ann-456
semiont bind doc-123 ann-456 target-789
```

**[Semiont SDK](../../packages/sdk/README.md)** — type-safe TypeScript SDK organized by the seven verbs. `SemiontClient.signIn(...)` is the credentials-first one-line construction for scripts. Long-running scripts that span token expiry use `SemiontSession.signIn(...)` instead — same shape, plus refresh and persistence.

The SDK is RxJS-native — live queries and progress streams are real Observables — but its return values implement `PromiseLike<T>`, so `await semiont.X.Y(...)` works directly without learning RxJS. Reach for `.subscribe(...)` only when you want progress events or live updates, and `.pipe(...)` only when you want operator composition. The deeper guides live alongside the package: **[Usage.md](../../packages/sdk/docs/Usage.md)** is the per-namespace tour, **[REACTIVE-MODEL.md](../../packages/sdk/docs/REACTIVE-MODEL.md)** explains the Promise-shape-over-Observable design, and **[CACHE-SEMANTICS.md](../../packages/sdk/docs/CACHE-SEMANTICS.md)** is the live-query cache contract.

```typescript
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signIn({ baseUrl: 'http://localhost:4000', email, password });

await semiont.mark.assist(resourceId, 'linking', { entityTypes: ['Person'] });
const context = await semiont.gather.annotation(annId, resourceId);
const results = await semiont.match.search(resourceId, refId, context);
await semiont.bind.body(resourceId, annId, [{ op: 'add', item: { type: 'SpecificResource', source: targetId } }]);
```

**[Agent Skills](skills/)** — ready-made skill definitions that agentic coding assistants like Claude Code can use to drive the full pipeline without writing integration code.

See the **[Local Semiont Overview](../system/LOCAL-SEMIONT.md)** for alternative setup paths.
