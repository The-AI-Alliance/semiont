# Beckon

Beckon directs attention: it points another participant at a passage, or opens a resource on their screen. It is the one attention-directing verb. It writes nothing and reads nothing. It exists because other people and agents are in the knowledge base at the same time as you.

## Operations

| SDK method | Returns | On the wire | Does on every other participant's viewer |
|---|---|---|---|
| `beckon.attention` | how many clients it reached | `beckon:focus` | Scrolls to an annotation |
| `beckon.click` | how many clients it reached | `browse:click` | Opens an annotation |
| `beckon.openResource` | how many clients it reached | `browse:resource-open` | Opens a resource |
| `beckon.sparkleAll` | how many clients it reached | `beckon:sparkle` | Draws the eye to an annotation |

Each is a frame sent with no reply awaited. The gateway relays it to every connected client.

## Rules

**Nothing is recorded.** A beckon is delivered to whoever is connected at that moment and dropped for everyone else. There is no queue and no retry.

**The count is not a confirmation.** Each drive resolves with the number of clients the gateway delivered it to, or with no count when the gateway keeps none. A client is a connection, not a pair of eyes: zero means nobody could have seen it, and any other number does not mean somebody did.

**There is no addressing.** A beckon reaches every client. The sender's own viewer receives it too.

**Focus points; a click opens.** `beckon:focus` scrolls a viewer to an annotation and stops. `browse:click` opens it. A guide chooses between "notice this" and "read this".

**`beckon:focus` may name a resource as a guard.** A viewer showing a different resource ignores it. It never moves a viewer to another resource: that is `browse:resource-open`. With no resource named, the viewer scrolls.

**Presence is the consumer's to build.** Beckon delivers signals. It keeps no record of who is looking at what, and aggregates nothing. An application that wants "three people are here" builds it from these signals and its own state.

## Example

```typescript
const watching = await semiont.beckon.attention(resourceId, annotationId);
if (watching === 0) console.warn('nobody is watching');

await semiont.beckon.openResource(resourceId);
await semiont.beckon.sparkleAll(annotationId);
```

From the launcher: `semiont beckon <resourceId> --annotation <annotationId>`.

## Local signals

`beckon.hover` and `beckon.sparkle` publish on the client's own bus and nowhere else: one viewer's own highlight when the pointer rests on an annotation, and its own sparkle on an annotation just created. How a viewer turns hovers and clicks into highlights and scrolling is react-ui's: see [annotation interaction](../../../packages/react-ui/docs/ANNOTATION-CLICK.md).

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/beckon.ts](../../../packages/sdk/src/namespaces/beckon.ts)
- The gateway's relay: [apps/gateway/src/routes/bus.rs](../../../apps/gateway/src/routes/bus.rs) and [stream.rs](../../../apps/gateway/src/routes/stream.rs)
- The launcher verb: [apps/launcher/internal/verbs/beckon.go](../../../apps/launcher/internal/verbs/beckon.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
