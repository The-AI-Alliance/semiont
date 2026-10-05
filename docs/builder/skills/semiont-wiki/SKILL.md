---
name: semiont-wiki
description: Run the knowledge enrichment pipeline on a resource using @semiont/sdk — detect entity references, resolve them against the KB, and generate new resources for unresolved ones
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user turn a resource's mentions into a connected wiki with `@semiont/sdk`: detect the entities a document mentions, link each mention to the resource about that entity, and generate a resource for an entity the knowledge base does not have yet.

This skill builds the canonical-node layer of [the layered data model](../README.md#the-layers). Every mention of one entity ends up bound to one resource, whose purpose is to be referred to. For a resource whose purpose is to be read (an investigation, a plot arc, a doctrinal trace), see [`semiont-aggregate`](../semiont-aggregate/SKILL.md).

The pipeline:

1. **Mark**: detect entity references (`mark.assist` with motivation `linking`).
2. **Browse**: list the references that are not bound yet (`browse.annotations`).
3. **Gather**: assemble the context around one reference (`gather.annotation`).
4. **Match**: search the knowledge base with that context (`match.search`).
5. **Bind** or **yield**: link the reference to the best candidate (`bind.body`), or generate a resource from the context (`yield.fromContext`). The knowledge base binds the reference to a resource generated from its context.

Steps 3 to 5 run once for each unbound reference. The score that separates "bind" from "generate" is yours to set.

## Before you start: declare the entity types

The entity types you detect in step 1 and stamp on generated resources in step 5 must be in the knowledge base's vocabulary, declared with `frame.addEntityTypes`. A `linking` job or a generation that names a type nobody declared is refused: `Entity type not registered: <name>`. [`semiont-ingest`](../semiont-ingest/SKILL.md) normally declares them once, at ingest, and `browse.entityTypes()` lists what is declared.

```typescript
await semiont.frame.addEntityTypes(['Location', 'Person', 'Organization', 'Concept']);
```

Adding a type that is already there changes nothing, so the call is safe to repeat.

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs) and a wiki build runs longer than that, so use a session, not a bare client. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-wiki', label: 'Semiont',
    host: url.hostname, port: Number(url.port || 4000),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  }),
  storage: new InMemorySessionStorage(),
  onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
    console.error(`Approve this script at ${verificationUriComplete ?? verificationUri}`);
    if (!verificationUriComplete) console.error(`Code: ${userCode}`);
  },
});
const semiont = session.client;
```

## Step 1: detect entity references

`mark.assist` creates a job for the stack's worker and follows it to its end. Awaiting it resolves to the job's last event, the `complete` one, which carries the result. For `linking` the options must name at least one entity type; the worker runs one detection per type.

```typescript
import { entityType, resourceId } from '@semiont/sdk';

const rId = resourceId('doc-123');

const done = await semiont.mark.assist(rId, 'linking', {
  entityTypes: [entityType('Location'), entityType('Person')],
});

const result = done.kind === 'complete' ? done.data.result : undefined;
if (result?.kind === 'reference-annotation') {
  console.log(`Created ${result.totalEmitted} of ${result.totalFound} references`);
}
```

Set `includeDescriptiveReferences: true` to detect a description that names nobody ("the property owner", "her eldest son") as well as names.

## Step 2: list the unbound references

A detected reference has a body that names its entity type and nothing else. Binding adds a `SpecificResource` body, so a reference without one is unbound. `browse.annotations(...)` is a live query; `.fresh()` reads it once.

```typescript
const annotations = await semiont.browse.annotations(rId).fresh();

const unbound = annotations.filter((ann) => {
  const bodies = ann.body === undefined ? [] : Array.isArray(ann.body) ? ann.body : [ann.body];
  return ann.motivation === 'linking' && !bodies.some((b) => b.type === 'SpecificResource');
});

console.log(`${unbound.length} references to resolve`);
```

## Steps 3 to 5: gather, match, then bind or generate

For one unbound reference: gather its context, match it against the knowledge base, and bind it to the best candidate if that candidate scores high enough. Otherwise generate a resource from the same context. `yield.fromContext` takes no ids: the gathered context says which reference it is about, and when the resource is created the knowledge base binds that reference to it. Do not bind it again.

```typescript
import { annotationId, type Annotation, type ResourceId } from '@semiont/sdk';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);

async function resolveReference(rId: ResourceId, ann: Annotation, name: string): Promise<void> {
  const annId = annotationId(ann.id);

  // Step 3: gather the context around the reference
  const gathered = await semiont.gather.annotation(rId, annId, { contextWindow: 2000 });
  const context = gathered.response;

  // Step 4: match it against the knowledge base
  const matched = await semiont.match.search(rId, annId, context, {
    limit: 10,
    useSemanticScoring: true,
  });
  const top = matched.response[0];

  if (top && (top.score ?? 0) >= MATCH_THRESHOLD) {
    // Step 5a: bind to the resource that exists
    await semiont.bind.body(rId, annId, [{
      op: 'add',
      item: { type: 'SpecificResource', source: top['@id'], purpose: 'linking' },
    }]);
    console.log(`Bound "${name}" to ${top.name} (score ${top.score})`);
    return;
  }

  // Step 5b: generate a resource; the knowledge base binds the reference to it
  const generated = await semiont.yield.fromContext(context, {
    title: name,
    storageUri: `file://generated/${name.toLowerCase().replace(/\s+/g, '-')}.md`,
  });
  const result = generated.kind === 'complete' ? generated.data.result : undefined;
  if (result?.kind !== 'generation') throw new Error(`Nothing was generated for "${name}"`);
  console.log(`Generated "${name}" as ${result.resourceId}`);
}
```

`name` is the text the reference covers. For a text resource that is the annotation's `TextQuoteSelector`:

```typescript
import type { Annotation } from '@semiont/sdk';

function quotedText(ann: Annotation): string {
  const selector = typeof ann.target === 'string' ? undefined : ann.target.selector;
  const selectors = selector === undefined ? [] : Array.isArray(selector) ? selector : [selector];
  for (const s of selectors) {
    if (s.type === 'TextQuoteSelector') return s.exact;
  }
  return '';
}
```

## Complete script

```typescript
import {
  SemiontSession,
  InMemorySessionStorage,
  httpKb,
  annotationId,
  entityType,
  resourceId,
  type Annotation,
} from '@semiont/sdk';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);
const ENTITY_TYPES = (process.env.ENTITY_TYPES ?? 'Location')
  .split(',')
  .map((t) => entityType(t.trim()));

function quotedText(ann: Annotation): string {
  const selector = typeof ann.target === 'string' ? undefined : ann.target.selector;
  const selectors = selector === undefined ? [] : Array.isArray(selector) ? selector : [selector];
  for (const s of selectors) {
    if (s.type === 'TextQuoteSelector') return s.exact;
  }
  return '';
}

function isUnbound(ann: Annotation): boolean {
  const bodies = ann.body === undefined ? [] : Array.isArray(ann.body) ? ann.body : [ann.body];
  return ann.motivation === 'linking' && !bodies.some((b) => b.type === 'SpecificResource');
}

async function runWikiPipeline(resourceIdStr: string): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-wiki', label: 'Semiont',
      host: url.hostname, port: Number(url.port || 4000),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    }),
    storage: new InMemorySessionStorage(),
    onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
      console.error(`Approve this script at ${verificationUriComplete ?? verificationUri}`);
      if (!verificationUriComplete) console.error(`Code: ${userCode}`);
    },
  });
  const semiont = session.client;
  const rId = resourceId(resourceIdStr);

  try {
    // Step 1: detect entity references
    console.log('Detecting entity references...');
    await semiont.mark.assist(rId, 'linking', { entityTypes: ENTITY_TYPES });

    // Step 2: list the unbound references
    const unbound = (await semiont.browse.annotations(rId).fresh()).filter(isUnbound);
    console.log(`${unbound.length} references to resolve`);

    // Steps 3 to 5, once for each
    for (const ann of unbound) {
      const annId = annotationId(ann.id);
      const name = quotedText(ann);

      const gathered = await semiont.gather.annotation(rId, annId, { contextWindow: 2000 });
      const context = gathered.response;

      const matched = await semiont.match.search(rId, annId, context, {
        limit: 10,
        useSemanticScoring: true,
      });
      const top = matched.response[0];

      if (top && (top.score ?? 0) >= MATCH_THRESHOLD) {
        await semiont.bind.body(rId, annId, [{
          op: 'add',
          item: { type: 'SpecificResource', source: top['@id'], purpose: 'linking' },
        }]);
        console.log(`Bound "${name}" to ${top.name} (score ${top.score})`);
        continue;
      }

      const generated = await semiont.yield.fromContext(context, {
        title: name,
        storageUri: `file://generated/${name.toLowerCase().replace(/\s+/g, '-')}.md`,
      });
      const result = generated.kind === 'complete' ? generated.data.result : undefined;
      if (result?.kind !== 'generation') throw new Error(`Nothing was generated for "${name}"`);
      console.log(`Generated "${name}" as ${result.resourceId}`);
    }
  } finally {
    await session.dispose();
  }
  console.log('Pipeline complete.');
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx pipeline.ts <resourceId>');
  process.exit(1);
}
runWikiPipeline(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Find the resource id first** if the user gives a name: `await semiont.browse.resources({ search: '<name>' }).fresh()` and pick from `.resources`.
- **Ask which entity types to detect** (Location, Person, Organization, Concept and so on). The worker runs one detection per type, so more types means a longer job.
- **The threshold is in Matcher points, not a probability.** A candidate's score is a sum of points for the signals it matched: entity types in common, how well its name matches, how it is already connected to the source. 30 is selective and 15 is permissive. At 0 every reference binds to its top candidate, if it has one.
- **`useSemanticScoring: true`** has a model score the top candidates against the passage, which improves precision and costs an inference call. Set it to `false` to rank on the structural signals alone.
- **Review what was generated.** A generated resource is a first draft written by a model. Its result says `truncated: true` when the model ran out of tokens before it finished.
- **Check results** with `await semiont.browse.annotations(rId).fresh()`: the `linking` annotations that now have a `SpecificResource` body are bound.
- **To run on many resources**, loop over `(await semiont.browse.resources().fresh()).resources` and call the pipeline for each.
- **If detection creates nothing**, the document may not mention the types you asked for. `mark.assist` reads Markdown, plain text, HTML, JSON and PDF. A resource with no text at all, such as an image, fails the job, and a document whose text could not be read completes with a `declined` result.
- **Waiting.** `mark.assist` has no deadline: it follows its job to the end, asking for the job's status when the stream goes quiet. `yield.fromContext` gives up on a generation that says nothing for its stall deadline (two minutes, longer when `maxTokens` is large), asks for it to be cancelled, and rejects with `GenerationStallError`. Set `stallDeadlineMs` to wait longer.
- **Progress.** To watch a job as it runs, call `.run(onEvent)` on the returned stream instead of awaiting it. It subscribes once and resolves to the last event. Do not await a call and also subscribe to it: the stream is cold, and that creates the job twice.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. `BusRequestError` (a bus request, with a code such as `bus.timeout`) and `JobFailedError` narrow it. See [Error Handling](../../Usage.md#error-handling).
