# Semiont Protocol

Semiont is infrastructure for **collaborative knowledge work** — humans and AI agents working the same corpus as peers, possibly across rooms or cities, possibly across time. This page is the conceptual spine: what the protocol contains, why it is shaped this way, and what it guarantees.

It is a *protocol* rather than an API for one reason: the participants are heterogeneous and the corpus outlives them. A person in a browser, an agent proposing references, a script ingesting sources, and a background worker doing analysis all need the same surface — and the knowledge they produce has to remain intelligible after every one of those clients has been rewritten. Anything that conforms can act as a peer; the knowledge base does not distinguish between humans and AI agents.

## The eight verbs

Every operation belongs to one of eight composable flows — *browse, bind, yield, mark, frame, gather, match, beckon*. Taken in the order you tend to meet them:

**Browse and Bind are ordinary wiki actions.** If you have used a wiki, you already know these.

- **[Browse](flows/BROWSE.md)** — navigate resources, panels, and views.
- **[Bind](flows/BIND.md)** — resolve an ambiguous reference to a specific target: the act of making a mention of "Paris" point at the right Paris.

**Yield and Mark are where delegation enters.** Each has a hand form and a delegated form that produce the same events — `yield.resource` uploads a document while `yield.fromResource` generates one; `mark.annotation` records a highlight you made while `mark.assist` runs AI detection across a resource. Same verb, same result shape, different author. This is where a collaborator — human or agent — takes work off your hands.

- **[Yield](flows/YIELD.md)** — introduce resources: upload documents, load pages, or generate new content from existing material.
- **[Mark](flows/MARK.md)** — annotate: highlights, assessments, comments, tags, and entity references, by hand or by detection.

**Frame sets the vocabulary those annotations draw on.** Entity types and tag schemas are not fixed by Semiont — participants author them, and the other seven verbs are expressed in whatever vocabulary a knowledge base has grown.

- **[Frame](flows/FRAME.md)** — define and evolve what *kinds* of things exist: entity types, tag schemas, eventually relation types and ontology imports.

**Gather and Match are the librarian verbs.** They add no knowledge; they find and assemble what is already there, and they are the two that draw on everything the corpus has accumulated — the knowledge graph, the vector index, and optional inference.

- **[Gather](flows/GATHER.md)** — assemble grounded, attributable context around a focal annotation or resource.
- **[Match](flows/MATCHER.md)** — search for candidate resources, combining structural signals with semantic recall and optional LLM re-ranking.

**Beckon is in a category of its own.**

- **[Beckon](flows/BECKON.md)** — direct a participant's attention to a passage or region. It writes nothing and persists nothing; it exists because other people and agents are in the corpus at the same time as you.

Per-flow contracts are in **[flows/README.md](flows/README.md)**.

## Why these eight

**The set is derived from the work, not from a data model.** Put several participants in front of a shared corpus — some of them human — and a short list of questions has to have answers. How do I move around? (Browse) How do I say that this mention means that thing? (Bind) How does new material get in? (Yield) How do I say something about this passage? (Mark) What kinds of things are we tracking? (Frame) How do I assemble everything known about something? (Gather) How do I find what's relevant? (Match) How do I know where you're looking? (Beckon) Eight questions, eight verbs. Remove any one and something becomes impossible to express rather than merely inconvenient.

**Nothing else earns verb status.** Jobs, sessions, permissions, transports, and storage are how the eight get executed, secured, and delivered. They are machinery. A verb is an operation on knowledge — something a participant *does* to the corpus or to another participant's attention — and that test is what keeps the surface from growing every time the implementation does.

**The altitude is the point.** A CRUD surface is too low: every application built on it reinvents what an annotation means, and each one invents it differently. A task-shaped API ("summarize this corpus") is too high: it locks you into someone else's workflow. These eight sit at the level where operations are meaningful to the domain but say nothing about your process.

**The boundary falls where durability changes.** Applications are ephemeral — rewritten, redesigned, increasingly generated outright. The knowledge they produce is not: it accretes in an event log that outlives every one of them. So the protocol constrains exactly the operations whose consequences persist, and says nothing about presentation. You may improvise screens, layouts, and interaction idioms freely. You may not improvise what an annotation is, how a reference resolves, or what an entity type means — because those choices are permanent and shared across every application that ever touches the corpus. Without that line, each generation of each app silently invents its own micro-schema and the corpus fragments.

**The set has stayed closed under pressure.** The honest test of a verb vocabulary is what happens when it meets a use case it wasn't designed for. So far, expressive pressure has arrived as *options on existing verbs* — output shape and citation controls on Yield, exclusion filters on Gather — rather than as new verbs. A document-grounded chat application was built from Yield, Gather, Mark, and Match with no protocol additions at all.

## What holds across every verb

**Peer symmetry.** Every operation — read, write, and coordination signal — flows through the same bus and the same event-sourced storage regardless of who initiates it. There is no privileged human path and no separate agent API. This is what makes the human/AI mix a deployment decision rather than an architectural one.

**Document-grounded knowledge.** Annotations anchor to specific passages via [W3C Web Annotation](W3C-WEB-ANNOTATION.md) targets and [selectors](W3C-SELECTORS.md). The knowledge graph is a projection of those grounded relationships, never a replacement for the source material.

**The event log is the system of record.** Domain events are the durable truth; the graph, the materialized views, and the search indexes are projections that can be rebuilt from it. A projection that disagrees with the log is a bug, not a second opinion.

**Coordination is first-class.** `beckon:hover`, `mark:shape-changed`, `bind:initiate`, `browse:click` and their siblings fan out to every connected participant as protocol events, not local UI state. A human's hover can inform an agent's relevance scoring; an agent's sparkle can direct a human's attention.

## One authority, two generated clients

The bus is not defined in prose. **[`specs/src/bus/registry.json`](../../specs/src/bus/registry.json)** is the machine-readable authority — **171 channels** and **34 request/reply operations**, each naming its payload schema. Of those channels, 19 are persisted domain events; the rest are correlation replies, ephemeral coordination signals, and UI events that nobody stores.

Both the TypeScript types in `packages/core` and the **[Go client](../../packages/sdk-go/README.md)** are *generated* from that file — edit the registry, run the generators. Two independent client implementations derive from one artifact, which is the practical answer to "is this a protocol or just a TypeScript library."

## Speaking the protocol

The eight flows are also the eight namespaces on the SDK's `SemiontClient` — `client.frame.*`, `client.mark.*`, `client.gather.*`, and so on. The protocol vocabulary and the typed surface are 1:1, so there is no translation step between reading the flow docs and writing code. Coordination signals appear on the same namespaces as `void`-returning methods (`beckon.hover`, `mark.changeShape`, `bind.initiate`).

```typescript
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({ baseUrl: 'http://localhost:4000', email, password });

await semiont.mark.assist(resourceId, 'linking', { entityTypes: ['Person'] });
const { response: context } = await semiont.gather.annotation(resourceId, annId);
const results = await semiont.match.search(resourceId, refId, context);
await semiont.bind.body(resourceId, annId, [{ op: 'add', item: { type: 'SpecificResource', source: targetId } }]);
```

Three surfaces speak these verbs:

- **[Semiont SDK](../../packages/sdk/README.md)** — the type-safe TypeScript client everything else is built on. RxJS-native, but every return value implements `PromiseLike<T>`, so `await` works without learning RxJS. See **[Usage.md](../../packages/sdk/docs/Usage.md)** for the per-namespace tour.
- **[Agent Skills](skills/)** — ready-made skill definitions that agentic coding assistants like Claude Code use to drive the pipeline without writing integration code.
- **[Semiont launcher](../../apps/launcher/README.md)** — the host-installed `semiont` binary exposes the flows as terminal verbs against a running stack; `semiont <verb> --help` for each verb's flags.

For product framing and getting a knowledge base running, see the **[project README](../../README.md)**.

## The specifications

- **[flows/README.md](flows/README.md)** — per-flow contracts for all eight verbs
- **[`specs/src/bus/registry.json`](../../specs/src/bus/registry.json)** — the generated bus authority: channels, payloads, operations
- **[EVENT-BUS.md](EVENT-BUS.md)** — channel naming, `correlationId` / `_userId` conventions, `_trace` carrier, gateway injection, resource scoping
- **[CHANNELS.md](CHANNELS.md)** — channel inventory: persisted events, ephemeral signals, correlation responses, resource broadcasts
- **[TRANSPORT-CONTRACT.md](TRANSPORT-CONTRACT.md)** — abstract `ITransport` guarantees every transport must honor
- **[TRANSPORT-HTTP.md](TRANSPORT-HTTP.md)** — HTTP+SSE wire format
- **[API.md](API.md)** — REST endpoint reference
- **[RBAC.md](RBAC.md)** — roles and permissions
- **[EXCHANGE.md](EXCHANGE.md)** — import/export and interchange
- **[W3C-WEB-ANNOTATION.md](W3C-WEB-ANNOTATION.md)** + **[W3C-SELECTORS.md](W3C-SELECTORS.md)** — standards compliance
