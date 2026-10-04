# Mark

Mark says something about a passage or a region: a highlight, a comment, an assessment, a tag, or a reference to something. It also records facts about a resource itself: its entity types, and whether it is archived. It is one of the four writing verbs, with [Yield](YIELD.md), [Bind](BIND.md) and [Frame](FRAME.md).

Every mark is a [W3C Web Annotation](../W3C-WEB-ANNOTATION.md). A person and an AI agent produce the same annotation through the same operation, and the record tells them apart only by who it is attributed to.

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `mark.annotation` | the new annotation's id | `mark:create-request` | the archivist |
| `mark.delete` | nothing | `mark:delete` | the archivist |
| `mark.archive`, `mark.unarchive` | nothing | `mark:archive`, `mark:unarchive` | the archivist |
| `mark.updateEntityTypes` | nothing | `mark:update-entity-types` | the archivist |
| `mark.assist` | a stream: the job's progress, then its outcome | `job:create`, with the job type for the motivation | the dispatcher admits it; a worker runs it |

A worker commits what it detected with `mark:commit`, one request carrying a batch of annotations and the job they were made for.

## What it records

Each of these is appended to the event log and delivered to the clients viewing that resource:

| Event | Records |
|---|---|
| `mark:added` | An annotation was created. The delivered event carries the annotation as it stands |
| `mark:removed` | An annotation was deleted |
| `mark:body-updated` | An annotation's body changed, by a list of add, remove and replace operations. The delivered event carries the annotation as it stands |
| `mark:entity-tag-added`, `mark:entity-tag-removed` | A resource gained or lost an entity type |
| `mark:archived`, `mark:unarchived` | A resource was archived or restored |

## Motivations

An annotation's `motivation` says why it was made, and decides its body:

| Motivation | Records | Body |
|---|---|---|
| `highlighting` | This passage matters | none |
| `commenting` | A note on the passage | the comment's text |
| `assessing` | A judgement of the passage | the assessment's text |
| `tagging` | The passage's role in a structure | a category, and the id of the [tag schema](FRAME.md#tag-schemas) it belongs to |
| `linking` | The passage refers to something | entity types, and once [bound](BIND.md), the resource it refers to |

## Rules

**The emitter never names itself.** An annotation's `creator` is derived by the knowledge base from the verified identity of the request. For an assisted annotation the creator is whoever asked for the job, and the model that produced it is its `generator`. `wasAttributedTo` lists both.

**A worker's commit must cite its job.** A commit from a worker that names no job, or a job that worker does not hold, is refused.

**A target is fixed at creation.** No event changes what an annotation points at. What an annotation can point at depends on the resource's media type: characters in text, a region on a page or an image. See [W3C Selectors](../W3C-SELECTORS.md).

**A text target carries two selectors that agree.** A position and a quote, reconciled when the annotation is written, so the quote is exactly the text at that position.

**Creating and deleting never conflict.** Two participants annotating the same passage at once produce two annotations. Nothing is rejected and nothing merges.

**Body updates apply in the order the log received them.** The semantics of each operation under concurrency are in [Bind](BIND.md#concurrent-updates).

**Entity types on a resource are a diff.** `mark.updateEntityTypes` is given the current set and the wanted set, and the difference is recorded as individual added and removed events. It classifies a resource with types the vocabulary already has; adding a type to the vocabulary is [Frame](FRAME.md).

**Assistance is a job.** `mark.assist` has no channel of its own. Progress and the outcome arrive on the job channels, matched by the job's id, and the annotations arrive as `mark:added` like any others. See [Jobs](../JOBS.md).

## Assistance

`mark.assist` takes a resource, a motivation, and options for that motivation:

| Motivation | Job type | Options |
|---|---|---|
| `highlighting` | `highlight-annotation` | instructions, density |
| `commenting` | `comment-annotation` | instructions, density, tone |
| `assessing` | `assessment-annotation` | instructions, density, tone |
| `tagging` | `tag-annotation` | a tag schema's id, and which of its categories |
| `linking` | `reference-annotation` | the entity types to look for, and whether to include descriptive references |

The whole document is read: a long one is processed in pieces sized to the model's limits, never truncated. How detection is done is the worker's: see [the job types](../../../packages/jobs/docs/JobTypes.md).

## Example

```typescript
// Annotate by hand
const { annotationId } = await semiont.mark.annotation({
  motivation: 'highlighting',
  target: {
    source: resourceId,
    selector: [
      { type: 'TextPositionSelector', start: 0, end: 11 },
      { type: 'TextQuoteSelector', exact: 'Hello World' },
    ],
  },
});

// Have an agent find the references
semiont.mark.assist(resourceId, 'linking', {
  entityTypes: ['Person', 'Organization'],
}).subscribe({
  next: (event) => console.log(event.kind, event),
  complete: () => console.log('Done'),
});
```

From the launcher: `semiont mark --delegate <resourceId> --motivation linking --entity-type Person`.

## Local signals

`mark.request`, `mark.requestAssist`, `mark.submit`, `mark.cancelPending`, `mark.dismissProgress` and `mark.reportDeleteError` publish on the client's own bus and nowhere else. They coordinate one viewer's annotation interface and are not part of the wire protocol. See [react-ui's events](../../builder/react-ui/EVENTS.md).

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/mark.ts](../../../packages/sdk/src/namespaces/mark.ts)
- What records the events: the Stower, in [packages/make-meaning/src/stower.ts](../../../packages/make-meaning/src/stower.ts)
- The detection workers: [packages/jobs](../../../packages/jobs/README.md)
- The launcher verb: [apps/launcher/internal/verbs/mark.go](../../../apps/launcher/internal/verbs/mark.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
