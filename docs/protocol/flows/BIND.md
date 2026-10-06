# Bind

Bind says what a reference refers to. A reference is an annotation with the motivation `linking`: it marks a mention of something, such as a person or a place. Binding attaches the resource the mention is about. It is one of the four writing verbs, with [Yield](YIELD.md), [Mark](MARK.md) and [Frame](FRAME.md).

Finding what a reference could refer to is reading, and belongs to [Gather](GATHER.md) and [Match](MATCH.md). Bind is the write that follows.

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `bind.body` | nothing; it resolves when the change is recorded | `bind:update-body` | the archivist |

`bind.body` takes a resource, an annotation, and a list of operations on the annotation's body:

| Operation | Does |
|---|---|
| `add` | Adds an item |
| `remove` | Removes the first item equal to the one given |
| `replace` | Replaces `oldItem` with `newItem` |

## What it records

Bind has no event of its own. A body change is recorded as [`mark:body-updated`](MARK.md#what-it-records), and delivered to the clients viewing that resource with the annotation as it stands afterwards. A client holding the annotation updates it in place, with no second request.

## A reference, before and after

Unbound, a reference's body holds only the entity types of what it mentions:

```json
{
  "body": [
    { "type": "TextualBody", "value": "Person", "purpose": "tagging" }
  ]
}
```

Bound, it also holds the resource:

```json
{
  "body": [
    { "type": "TextualBody", "value": "Person", "purpose": "tagging" },
    { "type": "SpecificResource", "source": "<resourceId>", "purpose": "linking" }
  ]
}
```

A reference is bound three ways: by `bind.body` with a resource that exists, by [generating](YIELD.md) the resource it refers to (the knowledge base binds it when the new resource is created), or by composing the resource by hand and then binding.

## Rules

**The write is confirmed.** `bind.body` resolves when the archivist has recorded the change, and rejects with the failure if it could not.

**Binding is reversible.** Removing the `SpecificResource` item returns the reference to its unbound state. Both the binding and the unbinding stay in the log.

### Concurrent updates

Two participants updating the same annotation at nearly the same time produce two events. The log receives them in some order, and each operation runs against the body the previous event left:

- **`add`** is idempotent on equal items. Adding the same resource twice leaves one. Adding two different resources leaves both: concurrent binds to different targets produce a reference linked to both, not a last write that wins.
- **`remove`** drops the first equal item if there is one. Two removes of the same item both succeed, and the second changes nothing.
- **`replace`** is keyed on `oldItem`. Of two concurrent replaces of the same item, the first applies and the second finds nothing to replace.

The protocol does not reject a second writer. An application that wants one target per reference has to arrange that itself.

## Example

```typescript
await semiont.bind.body(resourceId, annotationId, [
  { op: 'add', item: { type: 'SpecificResource', source: targetResourceId, purpose: 'linking' } },
]);
```

From the launcher: `semiont bind <resourceId> <annotationId> <targetResourceId>`, and `--unbind` to reverse it.

## Local signals

`bind.initiate` and `bind.reportBodyError` publish on the client's own bus and nowhere else. `bind:initiate` is how one viewer's interface says a binding should begin; it is not the write. See [react-ui's events](../../builder/react-ui/EVENTS.md).

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/bind.ts](../../../packages/sdk/src/namespaces/bind.ts)
- How body operations are applied: [the Archivist's specification](../ARCHIVIST.md), and [apps/archivist/record/src/view.rs](../../../apps/archivist/record/src/view.rs)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
