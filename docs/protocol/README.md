# Semiont Protocol

**Semiont accumulates mappings and builds the structures to navigate them.**

A mapping is a claim that some passage relates to some thing — a highlight, a comment, an entity reference, a resolved link between a mention and its target. Every one is anchored to a specific passage, attributed to the participant who asserted it, timestamped, and appended to a log that is never rewritten. Mappings only accumulate. The knowledge graph, the vector index, and the materialized views are projections built over them, so that what has accumulated can be navigated at corpus scale.

This is a *protocol* rather than an API because the participants are heterogeneous and the corpus outlives them. A person in a browser, an agent proposing references, a script ingesting sources, and a background worker doing analysis all need the same surface — and the mappings they deposit have to stay intelligible after every one of those clients has been rewritten. Anything that conforms can act as a peer; the knowledge base does not distinguish between humans and AI agents.

This page is the conceptual spine: what the protocol contains, why it is shaped this way, and what it guarantees.

## The eight verbs

Every operation belongs to one of eight verbs. They fall into three groups, by what they do to the knowledge base.

**Four verbs write.** Each adds to the record, and what it adds is permanent.

- **[Yield](flows/YIELD.md)** brings a resource in: by upload, by generation, by cloning.
- **[Mark](flows/MARK.md)** annotates a passage or a region: a highlight, a comment, an assessment, a tag, a reference.
- **[Bind](flows/BIND.md)** says what a reference refers to: the act of making a mention of "Paris" point at the right Paris.
- **[Frame](flows/FRAME.md)** defines the vocabulary the other three are expressed in: entity types and tag schemas. Neither is fixed by Semiont; the participants in a knowledge base grow them.

Yield and Mark are where delegation enters. Each has a form done by hand and a delegated form, and the two produce the same events: `yield.resource` uploads a document while `yield.delegate` generates one, and `mark.annotation` records a highlight you made while `mark.delegate` has an agent find them across a resource. Same verb, same result, different author.

**Three verbs read.** They add no knowledge. They find and assemble what is already there, drawing on everything the knowledge base has accumulated: the record, the graph and the vector index.

- **[Browse](flows/BROWSE.md)** reads the record: resources, annotations, history and vocabulary.
- **[Match](flows/MATCH.md)** searches: for resources by text, and for what a reference could refer to, ranking the candidates.
- **[Gather](flows/GATHER.md)** assembles the context around an annotation or a resource, grounded and attributable, and lists what refers to a resource.

**One verb directs attention.**

- **[Beckon](flows/BECKON.md)** points another participant at a passage or opens a resource on their screen. It writes nothing and reads nothing. It exists because other people and agents are in the knowledge base at the same time as you.

Each verb's contract is in **[flows/](flows/README.md)**.

## Why these eight

**The set is derived from the work, not from a data model.** Put several participants in front of a shared corpus — some of them human — and a short list of questions has to have answers. How does new material get in? (Yield) How do I say something about this passage? (Mark) How do I say that this mention means that thing? (Bind) What kinds of things are we tracking? (Frame) How do I read what is here? (Browse) How do I find what's relevant? (Match) How do I assemble everything known about something? (Gather) How do I show you where to look? (Beckon) Eight questions, eight verbs. Remove any one and something becomes impossible to express rather than merely inconvenient.

**Nothing else earns verb status.** Jobs, sessions, permissions, transports, and storage are how the eight get executed, secured, and delivered. They are machinery. A verb is an operation on knowledge — something a participant *does* to the corpus or to another participant's attention — and that test is what keeps the surface from growing every time the implementation does.

**The altitude is the point.** A CRUD surface is too low: every application built on it reinvents what an annotation means, and each one invents it differently. A task-shaped API ("summarize this corpus") is too high: it locks you into someone else's workflow. These eight sit at the level where operations are meaningful to the domain but say nothing about your process.

**The boundary falls where durability changes.** Applications are ephemeral — rewritten, redesigned, increasingly generated outright. The knowledge they produce is not: it accretes in an event log that outlives every one of them. So the protocol constrains exactly the operations whose consequences persist, and says nothing about presentation. You may improvise screens, layouts, and interaction idioms freely. You may not improvise what an annotation is, how a reference resolves, or what an entity type means — because those choices are permanent and shared across every application that ever touches the corpus. Without that line, each generation of each app silently invents its own micro-schema and the corpus fragments.

**The set stays closed under pressure.** The honest test of a verb vocabulary is what happens when it meets a use case it wasn't designed for. Expressive pressure arrives as *options on existing verbs* — output shape and citation controls on Yield, exclusion filters on Gather — rather than as new verbs. A document-grounded chat application is built from Yield, Mark, Match and Gather with no protocol additions at all.

## What holds across every verb

**Peer symmetry.** Every operation — read, write, and coordination signal — flows through the same bus and the same event-sourced storage regardless of who initiates it. There is no privileged human path and no separate agent API. This is what makes the human/AI mix a deployment decision rather than an architectural one. The record describes a person's act and an agent's act the same way: every event carries the verified DID of its emitter, and who requested, who produced, and who is responsible are derived from that — for a human and for software alike.

**Document-grounded knowledge.** Annotations anchor to specific passages via [W3C Web Annotation](W3C-WEB-ANNOTATION.md) targets and [selectors](W3C-SELECTORS.md). The knowledge graph is a projection of those grounded relationships, never a replacement for the source material.

**The event log is the system of record.** Domain events are the durable truth; the graph, the materialized views, and the search indexes are projections that can be rebuilt from it. A projection that disagrees with the log is a bug, not a second opinion.

**Coordination is first-class.** `beckon:focus`, `beckon:sparkle`, `browse:click` and `browse:resource-open` reach every connected participant as protocol events, not as one viewer's local state. An agent can direct a person's attention to what it found, and a person can direct an agent's.

## One authority, three generated clients

The bus is not defined in prose. **[`specs/src/bus/registry.json`](../../specs/src/bus/registry.json)** is the machine-readable authority: every channel, the schema of what it carries, the request and reply channels of every operation, which channels are events of the record, and who receives each. [CHANNELS.md](CHANNELS.md) is the readable inventory.

The TypeScript, Rust, Go and Python clients each *generate* their channel tables from that file. Four implementations in four languages derive from one artifact, which is the practical answer to "is this a protocol or just a TypeScript library."

The same holds one level up. **[`specs/src/client/surface.json`](../../specs/src/client/surface.json)** declares every method an SDK gives each verb and the shape of what it returns. Every SDK is held to it: a lint checks each SDK's methods against the table, and each SDK's own tests run the table's cases.

## Speaking the protocol

The eight verbs are also the eight namespaces of a client in every SDK: `yield`, `mark`, `bind`, `frame`, `browse`, `match`, `gather` and `beckon`. The protocol's vocabulary and the typed surface are one to one, so there is no translation step between reading a verb's contract and writing code. In TypeScript:

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const session = await SemiontSession.signInDevice({
  kb: httpKb({ id: 'demo', label: 'Demo', host: 'localhost', port: 4000, protocol: 'http' }),
  storage: new InMemorySessionStorage(),
  onCode: ({ verificationUriComplete, verificationUri }) =>
    console.error(`Approve at ${verificationUriComplete ?? verificationUri}`),
});
const semiont = session.client;

await semiont.mark.delegate(resourceId, { motivation: 'linking', entityTypes: ['Person'] });  // write
const { response: context } = await semiont.gather.annotation(resourceId, annotationId);   // read
const results = await semiont.match.search(resourceId, annotationId, context);              // read
await semiont.bind.body(resourceId, annotationId, [                                          // write
  { op: 'add', item: { type: 'SpecificResource', source: targetResourceId, purpose: 'linking' } },
]);
```

Three surfaces speak these verbs:

- **The SDKs**, in [TypeScript](../../packages/sdk/README.md), [Rust](../../packages/sdk-rust/README.md) and [Python](../../packages/sdk-python/README.md), are the typed clients everything else is built on. See **[the builder docs](../builder/README.md)**.
- **[Agent skills](../builder/skills/)** are ready-made skill definitions that agentic coding assistants use to work in a knowledge base without writing integration code.
- **[The launcher](../../apps/launcher/README.md)**, the `semiont` binary, exposes the verbs as terminal commands against a running stack; `semiont <verb> --help` for each.

For product framing and getting a knowledge base running, see the **[project README](../../README.md)**.

## The specifications

| Doc | What it specifies |
|---|---|
| [flows/](flows/README.md) | Each of the eight verbs: its operations, what it records, and the rules a client can rely on |
| [EVENT-BUS.md](EVENT-BUS.md) | The bus: channel naming, identity stamped by the gateway, correlation, scoping, what is recorded |
| [CHANNELS.md](CHANNELS.md) | The channel inventory, by class |
| [ARCHIVIST.md](ARCHIVIST.md) | The record: the event log, the views and the other files the Archivist keeps, the commands it records, the reads and the HTTP surface it answers, the facts it publishes |
| [JOBS.md](JOBS.md) | Delegated work: the job record and its states, the `job:*` channels the dispatcher answers, claims, checkpoints, retries, cancellation |
| [TRANSPORT-CONTRACT.md](TRANSPORT-CONTRACT.md) | What every transport promises a client, in any language |
| [TRANSPORT-HTTP.md](TRANSPORT-HTTP.md) | The HTTP transport: `/bus/emit`, the `/bus/subscribe` stream, content, limits |
| [CACHE-SEMANTICS.md](CACHE-SEMANTICS.md) | The numbered behaviors every SDK's live queries are held to |
| [RBAC.md](RBAC.md) | Roles: the one authorization decision, and the two roles that mark services |
| [W3C-WEB-ANNOTATION.md](W3C-WEB-ANNOTATION.md), [W3C-SELECTORS.md](W3C-SELECTORS.md) | The annotation model, and which selectors apply to which media |

The machine-readable half is [`specs/`](../../specs/README.md): the OpenAPI document, the bus registry, the SDK surface, and the shared case tables every implementation runs.
