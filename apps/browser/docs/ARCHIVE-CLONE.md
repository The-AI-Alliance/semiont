# Archive and Clone

Two lifecycle actions on a resource. Both live in the **Resource Info** panel
(`ResourceInfoPanel`, `@semiont/react-ui`) and both go through the SDK.

## Archive

Archiving marks a resource as archived; unarchiving reverses it.

```ts
await session.client.mark.archive(resourceId);
await session.client.mark.unarchive(resourceId);
```

Each is a confirmed write: it resolves when the knowledge base has answered, and rejects if the
command failed. The panel shows **Archive** or **Unarchive** according to the resource's
archived state, and the resource page shows an archived badge in annotate mode.

## Clone

Cloning makes a new, editable resource from an existing one, and records where it came from.

1. **Ask for a token.** The Clone action asks the knowledge base for a short-lived token for
   the source:

   ```ts
   const { token, expiresAt } = await session.client.yield.cloneToken(resourceId);
   ```

2. **Go to Compose.** The Browser navigates to `/know/compose?mode=clone&token=<token>`.

3. **Load the source.** The Compose page resolves the token to the source's description and
   reads its content, so the copy starts from the source's name and text:

   ```ts
   declare const token: string; // from the page's ?token= query

   const source = await client.yield.fromToken(token);
   const { data, contentType } = await client.browse.resourceRepresentation(source['@id']);
   ```

4. **Save.** Saving creates the new resource from the token:

   ```ts
   declare const token: string;
   declare const name: string; // the copy's name, as edited

   const { resourceId } = await client.yield.createFromToken({
     token,
     name,
     content,
     archiveOriginal: true,   // archive the source once the copy exists — the Compose page's default
   });
   ```

The copy's description carries `wasDerivedFrom`, the source's `ResourceId`. The Resource Info
panel shows it as a link back to the source.

The token carries its own `expiresAt`. Tokens are issued and checked by the Archivist's
`CloneTokenManager` (see [KNOWLEDGE-SYSTEM.md](../../../docs/system/KNOWLEDGE-SYSTEM.md)).

## Related

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the Browser reaches the knowledge base
- [API-INTEGRATION.md](./API-INTEGRATION.md) — the SDK's namespaces and the bus
