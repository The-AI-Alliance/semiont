# Yield

Yield brings a resource into the knowledge base: by upload, by generation, or by cloning one that exists. It is one of the four writing verbs, with [Mark](MARK.md), [Bind](BIND.md) and [Frame](FRAME.md).

A resource is anything a knowledge base holds: a document, an image, a PDF, any file. Once yielded it can be annotated, linked, gathered around and searched for.

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `yield.resource` | an upload: its progress, then the new resource's id | `POST /resources`, a multipart upload | the archivist, through the gateway |
| `yield.fromContext` | a stream: the job's progress, then its outcome | `job:create`, with job type `generation` | the dispatcher admits it; a worker runs it |
| `yield.cloneToken` | a short-lived token for one resource | `yield:clone-token-requested` | the archivist |
| `yield.fromToken` | the resource a token names | `yield:clone-resource-requested` | the archivist |
| `yield.createFromToken` | the id of the new copy | `POST /resources`, an upload carrying the token | the archivist, through the gateway |

The return shapes are the SDK's, the same in every language: see [the reactive model](../../builder/REACTIVE-MODEL.md).

## What it records

Each of these is appended to the event log and delivered to clients:

| Event | Records | Delivered to |
|---|---|---|
| `yield:created` | A resource came into being: its name, its media type, where its bytes are stored, and who and what produced it | everyone |
| `yield:cloned` | A resource was created as a copy of another | everyone |
| `yield:updated` | A resource's content was replaced | everyone |
| `yield:moved` | A resource's file moved in the working tree | everyone |
| `yield:representation-added`, `yield:representation-removed` | A rendition of the resource was added or removed | clients viewing that resource |

## Rules

**Bytes never ride the bus.** An upload is an HTTP request, and so is every read of content. The bus carries what happened to a resource, never the resource. See [what does not ride the bus](../EVENT-BUS.md#what-rides-the-bus-and-the-five-things-that-deliberately-do-not).

**The emitter never names itself.** A resource's `creator` and `wasAttributedTo` are derived by the knowledge base from the verified identity of whoever made the request. For a generated resource the creator is whoever asked for the job, and the model that wrote it is its `generator`.

**Generation takes a gathered context and nothing else to say what it is about.** `yield.fromContext` is given the context that [Gather](GATHER.md) assembled. The job's resource, and the reference to resolve, are derived from that context's focus. A request that supplies its own ids is refused.

- From an **annotation's** context, the new resource is what the reference refers to. When it is created, the knowledge base links the reference to it, which arrives as a `mark:body-updated` on the source resource.
- From a **resource's** context, there is no reference to resolve. The worker creates a linking annotation on the source resource that points at the new one, so the derivation can be followed.

**A generated resource records what it was derived from.** That provenance is part of `yield:created` and is permanent.

**`job:complete` is the outcome, not `yield:create-ok`.** A generation is finished when the job says so. `job:complete` is announced to everyone, after every citation the generation produced has been attached to the new resource, and its result carries the new resource's id. A link built from that id opens a resource whose citations have landed. See [Jobs](../JOBS.md).

**A generation that asks for citations gets annotations, not inline links.** With `cite` set, each claim the model ties to a source becomes a linking annotation on the generated resource, pointing at the passage it came from. A citation of something that was not in the context is dropped.

**A clone token is single-purpose.** It names one resource, expires after 15 minutes, and is spent by creating one copy. The copy's bytes are uploaded like any others.

## Media types

What can be uploaded, authored and generated is declared per media type in [`specs/src/media-types/registry.json`](../../../specs/src/media-types/registry.json). Any listed type can be uploaded. Generation targets the types the registry marks `generatable`. See [Media Types](../../architecture/MEDIA-TYPES.md).

## Example

```typescript
// Upload
const { resourceId } = await semiont.yield.resource({
  name: 'My Document',
  file: new File([content], 'doc.md'),
  format: 'text/markdown',
  storageUri: 'file://docs/doc.md',
});

// Generate from a gathered context. Awaiting gives the outcome.
const done = await semiont.yield.fromContext(gatheredContext, {
  title: 'Generated Summary',
  storageUri: 'file://generated/summary.md',
});
if (done.kind === 'complete' && done.data.result?.kind === 'generation') {
  console.log(done.data.result.resourceId);
}
```

From the launcher: `semiont yield --upload <file>`, and `semiont yield --help` for generation.

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/yield.ts](../../../packages/sdk/src/namespaces/yield.ts)
- What records the events: the Stower, in [packages/make-meaning/src/stower.ts](../../../packages/make-meaning/src/stower.ts)
- The generation worker: [packages/jobs](../../../packages/jobs/README.md), and [its job types](../../../packages/jobs/docs/JobTypes.md)
- The launcher verb: [apps/launcher/internal/verbs/yield.go](../../../apps/launcher/internal/verbs/yield.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
