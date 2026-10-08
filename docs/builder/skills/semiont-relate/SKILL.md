---
name: semiont-relate
description: Record relationships between canonical nodes — read a passage and the nodes it mentions, decide how they relate, and write each relationship as a Relationship resource the passage is bound to
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user record how the entities in a Semiont knowledge base relate. After [`semiont-wiki`](../semiont-wiki/SKILL.md) has given each entity a resource of its own (a character, a party, a place, a case), the next step is the relationships between them: who is whose parent, which party is the counterparty under a contract, where a character was exiled to, which judge wrote which opinion.

This skill builds the edge layer of [the layered data model](../README.md#the-layers).

## What an edge is

A reference in Semiont leads to one resource: an annotation on a passage, bound to the resource the passage mentions. A relationship has two ends, so it is recorded as a resource of its own:

- A **Relationship resource** for each related pair, with entity types `['Relationship', '<type>']`. Its text names the two nodes, and a reference on each name is bound to that node.
- A **reference on the passage** that establishes the relationship, bound to the Relationship resource and tagged with the relationship's type.

The graph then reads passage → relationship → the two nodes. `gather.referencedBy(node)` lists the relationships a node is in, `gather.referencedBy(relationship)` lists every passage that establishes one, and `browse.resources({ entityType: 'kinship' })` lists every relationship of a type.

## Who decides

The stack's worker detects mentions of entity types. It has no job that extracts relationships, and a `linking` job takes no `instructions`. Deciding that a passage relates two nodes is the judgment this skill supplies: yours, reading the passage as the assistant, or the user's. The script reads what you need to decide and records what you decided.

## Before you start: declare the relationship types

Each relationship type is an entity type: it is stamped on the Relationship resources and names the references that lead to them. Declare the ones the corpus uses. [`semiont-ingest`](../semiont-ingest/SKILL.md) is the usual place.

```typescript
await semiont.frame.addEntityTypes([
  'Relationship',
  'kinship', 'patronage', 'antagonism', 'alliance',      // people
  'counterparty', 'employer-employee', 'lessor-lessee',  // legal and commercial
  'judge-of-court', 'attorney-for-client',               // judicial
  'born-in', 'exiled-to', 'imprisoned-at',               // a person and a place
]);
```

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs), so a session, not a bare client, is what keeps a script working past that. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-relate', label: 'Semiont',
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

## Step 1: read a passage and the nodes it mentions

A reference that has been bound has a `SpecificResource` body naming its node: `isResolvedReference` is that test, and `getBodySource` gives the node. Print the passage and its bound references, and read them.

```typescript
import { getBodySource, isResolvedReference } from '@semiont/sdk';

const text = await semiont.browse.resourceContent(rId);
const annotations = await semiont.browse.annotations(rId).fresh();

console.log(text);
for (const ann of annotations) {
  if (isResolvedReference(ann)) console.log(`mentions ${getBodySource(ann.body)}`);
}
```

A passage with fewer than two bound references has no pair to relate. Run [`semiont-wiki`](../semiont-wiki/SKILL.md) on it first.

## Step 2: decide

For each relationship the passage states, write down the passage, the exact text that establishes it, the type, and the two nodes. Record only what the text says: two names in one paragraph are not a relationship.

```json
[
  {
    "passage": "res-prometheus-bound-1",
    "exact": "Prometheus, son of Iapetus",
    "type": "kinship",
    "a": "res-prometheus",
    "b": "res-iapetus"
  }
]
```

Order matters for a directed type: for `born-in`, `a` is the person and `b` the place.

## Step 3: find or create the Relationship resource

One resource for each pair and type, however many passages establish it. Its name is how the script finds it again.

```typescript
import type { ResourceDescriptor, ResourceId } from '@semiont/sdk';

async function relationshipResource(
  type: string, a: ResourceDescriptor, b: ResourceDescriptor,
): Promise<ResourceId> {
  const name = `${type}: ${a.name} and ${b.name}`;

  const listed = await semiont.match.resources(name, { entityType: type, limit: 100 }).fresh();
  const existing = listed.resources.find((r) => r.name === name);
  if (existing) return existing['@id'];

  const text = `# ${name}\n\n- From: ${a.name}\n- To: ${b.name}\n`;
  const { resourceId: relationshipId } = await semiont.yield.resource({
    name,
    file: Buffer.from(text, 'utf-8'),
    format: 'text/markdown',
    entityTypes: ['Relationship', type],
    storageUri: `file://generated/relationships/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
  });

  // The relationship refers to each of its two nodes.
  const refer = (node: ResourceDescriptor, prefix: string) => semiont.mark.annotation({
    motivation: 'linking',
    target: { source: relationshipId, selector: { type: 'TextQuoteSelector', exact: node.name, prefix } },
    body: [{ type: 'SpecificResource', source: node['@id'], purpose: 'linking' }],
  });
  await refer(a, 'From: ');
  await refer(b, 'To: ');
  return relationshipId;
}
```

## Step 4: bind the passage to it

The reference covers the text that establishes the relationship. Its `tagging` body names the relationship's type, as a detected reference's names its entity type.

```typescript
import type { ResourceId } from '@semiont/sdk';

async function recordEdge(passage: ResourceId, exact: string, type: string, relationship: ResourceId) {
  await semiont.mark.annotation({
    motivation: 'linking',
    target: { source: passage, selector: { type: 'TextQuoteSelector', exact } },
    body: [
      { type: 'TextualBody', value: type, purpose: 'tagging' },
      { type: 'SpecificResource', source: relationship, purpose: 'linking' },
    ],
  });
}
```

## Complete script

It reads the decisions from a JSON file shaped like step 2's and records each one.

```typescript
import { readFileSync } from 'node:fs';

import {
  SemiontSession, InMemorySessionStorage, httpKb, resourceId,
  type ResourceDescriptor, type ResourceId, type SemiontClient,
} from '@semiont/sdk';

interface Statement {
  passage: string;
  exact: string;
  type: string;
  a: string;
  b: string;
}

async function relationshipResource(
  semiont: SemiontClient, type: string, a: ResourceDescriptor, b: ResourceDescriptor,
): Promise<ResourceId> {
  const name = `${type}: ${a.name} and ${b.name}`;

  const listed = await semiont.match.resources(name, { entityType: type, limit: 100 }).fresh();
  const existing = listed.resources.find((r) => r.name === name);
  if (existing) return existing['@id'];

  const text = `# ${name}\n\n- From: ${a.name}\n- To: ${b.name}\n`;
  const { resourceId: relationshipId } = await semiont.yield.resource({
    name,
    file: Buffer.from(text, 'utf-8'),
    format: 'text/markdown',
    entityTypes: ['Relationship', type],
    storageUri: `file://generated/relationships/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
  });

  const refer = (node: ResourceDescriptor, prefix: string) => semiont.mark.annotation({
    motivation: 'linking',
    target: { source: relationshipId, selector: { type: 'TextQuoteSelector', exact: node.name, prefix } },
    body: [{ type: 'SpecificResource', source: node['@id'], purpose: 'linking' }],
  });
  await refer(a, 'From: ');
  await refer(b, 'To: ');
  return relationshipId;
}

async function relate(statementsPath: string): Promise<void> {
  const statements: Statement[] = JSON.parse(readFileSync(statementsPath, 'utf-8'));

  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-relate', label: 'Semiont',
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

  try {
    for (const s of statements) {
      const a = await semiont.browse.resource(resourceId(s.a)).fresh();
      const b = await semiont.browse.resource(resourceId(s.b)).fresh();
      const relationship = await relationshipResource(semiont, s.type, a, b);

      await semiont.mark.annotation({
        motivation: 'linking',
        target: { source: resourceId(s.passage), selector: { type: 'TextQuoteSelector', exact: s.exact } },
        body: [
          { type: 'TextualBody', value: s.type, purpose: 'tagging' },
          { type: 'SpecificResource', source: relationship, purpose: 'linking' },
        ],
      });
      console.log(`${s.type}: ${a.name} and ${b.name}, established in ${s.passage}`);
    }
  } finally {
    await session.dispose();
  }
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: tsx relate.ts <statements.json>');
  process.exit(1);
}
relate(file).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Run after the nodes exist.** A relationship joins two resources. Run [`semiont-wiki`](../semiont-wiki/SKILL.md) first, so the passage's mentions are bound to them.
- **You are the extractor.** Read the passage and the nodes it mentions, and write the statements. No job does it for you: a `linking` job takes no `instructions`, and one given them is refused.
- **The vocabulary belongs to the corpus.** Kinship, patronage and antagonism suit literature and myth. Counterparty, lessor-lessee and employer-employee suit contracts. Judge-of-court and attorney-for-client suit case law. Declare the types with `frame.addEntityTypes`.
- **Relationships are sparse.** A hundred passages might state twenty to fifty. If you are writing one for every pair of names in a paragraph, you are recording co-occurrence. Record what the text states.
- **One Relationship resource for each pair and type.** Every passage that establishes it is bound to the same one, so the resource collects its own evidence.
- **Edges feed aggregates.** [`semiont-aggregate`](../semiont-aggregate/SKILL.md) composes a family tree, a precedent graph or a party chart by walking them.
- **Check results** with `await semiont.gather.referencedBy(relationshipId).fresh()` for the passages that establish a relationship, and `await semiont.browse.resources({ entityType: 'kinship' }).fresh()` for every relationship of a type.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. See [Error Handling](../../Usage.md#error-handling).
