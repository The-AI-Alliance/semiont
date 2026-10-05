# Browse

Browse reads the knowledge base's record: its resources, their annotations, their history, and the vocabulary they are expressed in. It is one of the three reading verbs, with [Match](MATCH.md) and [Gather](GATHER.md). Reading changes nothing and leaves nothing behind.

## Operations

A live query is asked for once and then kept current: when something it shows changes, the client refreshes it. A one-shot read is asked and answered once. The behaviour of live queries is specified in [Cache Semantics](../CACHE-SEMANTICS.md).

| SDK method | Kind | On the wire | Gives |
|---|---|---|---|
| `browse.resource` | live query | `browse:resource-requested` | One resource's description |
| `browse.resources` | live query | `browse:resources-requested` | A page of the resources, filtered by entity type or by whether they are archived, with the total |
| `browse.annotations` | live query | `browse:annotations-requested` | Every annotation on a resource |
| `browse.annotation` | live query | `browse:annotation-requested` | One annotation |
| `browse.events` | live query | `browse:events-requested` | A resource's event history, each event with who did it |
| `browse.entityTypes` | live query | `browse:entity-types-requested` | The entity-type vocabulary |
| `browse.tagSchemas` | live query | `browse:tag-schemas-requested` | The registered tag schemas |
| `browse.agents` | live query | `browse:agents-requested` | The people and software agents the knowledge base knows |
| `browse.resourceEvents` | one-shot | `browse:events-requested` | A resource's event history, each event with who did it |
| `browse.annotationHistory` | one-shot | `browse:annotation-history-requested` | The event history of one annotation the resource holds: its creation and the changes to its body, each with who did it |
| `browse.resourceAnchoredText` | one-shot | `browse:anchored-text-requested` | A resource's text with the positions that index it, for a type whose text is derived, such as a scanned PDF |
| `browse.files` | one-shot | `browse:directory-requested` | A listing of a directory in the working tree |
| `browse.kb` | one-shot | `browse:kb-requested` | What the knowledge base says of itself: its name and its domain |
| `browse.resourceContent`, `browse.resourceRepresentation`, `browse.resourceRepresentationStream` | one-shot | `GET` on the content path | A resource's bytes |
| `browse.resourceGraph` | one-shot | `GET` on the content path | A resource's linked-data description |

Every bus read is answered by the archivist, on `browse:…-result` or `browse:…-failed`. Bytes are read over HTTP, never the bus.

## Signals that cross to other participants

Three `browse:` channels are not reads. They are delivered to every connected client and recorded nowhere:

| Channel | Carries | Meaning |
|---|---|---|
| `browse:resource-open` | a resource's id | **Drive**: put this resource on the participant's screen |
| `browse:click` | an annotation's id | **Drive**: open this annotation |
| `browse:resource-viewed` | a resource's id | **Report**: a viewer arrived at this resource |

Driving another participant's viewer is [Beckon](BECKON.md): `beckon.openResource` and `beckon.click` send the first two over the wire. `browse.openResource` and `browse.click` publish the same channels on the client's own bus only, for the viewer's own navigation.

## Rules

**A read is answered from what exists.** No `browse:` request appends to the log.

**A history says who did each thing.** An event names its actor by DID and nothing else. A history reply carries each event as the log holds it and, beside it, the `agent` that DID identifies: a person, or a software peer with its provider and model. A person's `name` is filled in from the knowledge base's record of what its people are called, and a person it has no name for carries none. The agent is made when the reply is made. It is in no log, and no name is written into an event's payload.

**Browse answers from the record.** The event log, the views made from it and the working tree are all a `browse:` read draws on. A question that needs the graph, the vector index or an embedding is retrieval, and belongs to the other two reading verbs: searching resources by text is [Match](MATCH.md), and what refers to a resource is [Gather](GATHER.md).

**A list of resources is the answer to a query, not a live collection.** It is refreshed when the client learns of a change it can see, which is not every change anywhere. See [what refreshes what](../CACHE-SEMANTICS.md#what-refreshes-what).

**Drive and report are never one channel.** A channel that carried both would be a feedback loop: a driver listening for arrivals would hear its own commands, and one viewer's click would move another's page.

**A drive carries an id and nothing else.** An annotation's id names one annotation on one resource, so `browse:click` needs no resource id, and a viewer that does not hold that annotation does nothing. No address in the application, no route and no locale ever crosses the wire.

**There is no addressing.** A drive reaches every connected client. A driver signed in as a person reaches that person's open viewers. The count of clients a drive reached is not a confirmation that anyone saw it.

**`browse:resource-viewed` means the content reached the screen**, however the participant got there: a followed drive, a link, the back button, or a typed address.

## Example

```typescript
// A live query: emits again whenever the resource changes
semiont.browse.resource(resourceId).subscribe((st) => {
  if (st.status === 'ready') console.log('Resource:', st.value.name);
});

// One-shot reads
const resource = await semiont.browse.resource(resourceId).fresh();
const history = await semiont.browse.annotationHistory(resourceId, annotationId);
const { name, domain } = await semiont.browse.kb();
```

From the launcher: `semiont browse`, and `semiont browse <resourceId> --browser` to open a resource in the Browser.

## Channels that stay in the page

`browse:entity-type-clicked`, and the `nav:`, `panel:`, `tabs:`, `shell:` and `settings:` channels, are published on a client's own bus and never cross the wire. They belong to the Browser's interface, not to the protocol. See [react-ui's event internals](../../../packages/react-ui/docs/EVENTS.md).

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/browse.ts](../../../packages/sdk/src/namespaces/browse.ts)
- What answers the reads: the Browser actor, in [packages/make-meaning/src/archivist/browser.ts](../../../packages/make-meaning/src/archivist/browser.ts)
- What a live query refreshes on: [specs/src/client/refresh.json](../../../specs/src/client/refresh.json)
- The launcher verb: [apps/launcher/internal/verbs/browse.go](../../../apps/launcher/internal/verbs/browse.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
