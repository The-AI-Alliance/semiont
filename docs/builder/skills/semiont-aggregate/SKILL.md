---
name: semiont-aggregate
description: Compose a synthesized aggregate resource — walk many annotations bound to or about a single anchor, assemble markdown, yield a Resource whose purpose is to be read (not referred to)
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user compose an aggregate: a resource written from what the knowledge base already holds about one subject. Aggregates are what a knowledge base delivers: a report on how later cases treated a precedent, a plot arc, a memo tracing a doctrine, a timeline of dated events, a checklist of open items.

This skill builds the aggregate layer of [the layered data model](../README.md#the-layers). An aggregate is written to be read, by a person or by a tool.

## Aggregate, or canonical node

One question separates this skill from [`semiont-wiki`](../semiont-wiki/SKILL.md): will annotations point at the new resource?

- **Yes**: it is a canonical node, the resource that mentions of an entity are bound to. Use `semiont-wiki`.
- **No**: it is an aggregate, a memo, table or summary that someone reads. Use this skill.

When a workflow does both, build the nodes first and write the report about them second.

## The shape

1. **Name the anchor**: the resource the aggregate is about. A case, a literary work, a person, a matter.
2. **Collect what refers to it.** `gather.referencedBy(anchor)` lists every reference bound to the anchor: the annotation, the resource it is on, and the text it covers.
3. **Gather an excerpt for each**, if the report quotes its sources (`gather.annotation`).
4. **Compose Markdown**: a title, a summary, a table or list with a link back to each source, and whatever narrative the report needs.
5. **Yield it** with `yield.resource`, stamped with the kind of aggregate it is and the umbrella type `Aggregate`.

Running the skill again writes a new aggregate beside the last one. Put the date in the `storageUri` so successive runs can be compared.

## Before you start: declare the aggregate's entity types

An aggregate is stamped with its kind and with `Aggregate`: `['SubsequentTreatment', 'Aggregate']`, `['PlotArc', 'Aggregate']`. Both belong in the knowledge base's vocabulary. [`semiont-ingest`](../semiont-ingest/SKILL.md) normally declares them at ingest. For a kind that was not declared then:

```typescript
await semiont.frame.addEntityTypes(['SubsequentTreatment', 'Aggregate']);
```

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs), so a session, not a bare client, is what keeps a script working past that. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-aggregate', label: 'Semiont',
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

## Steps 1 and 2: the anchor and what refers to it

```typescript
import { resourceId } from '@semiont/sdk';

const anchorId = resourceId('case-citizens-united');

const anchor = await semiont.browse.resource(anchorId).fresh();
const references = await semiont.gather.referencedBy(anchorId).fresh();

console.log(`${references.length} passages refer to ${anchor.name}`);
for (const ref of references) {
  console.log(`  ${ref.resourceName}: "${ref.target.selector.exact}"`);
}
```

Each entry is one reference annotation bound to the anchor: `id` is the annotation, `target.source` the resource it is on, `resourceName` that resource's name, and `target.selector.exact` the text it covers.

An aggregate about a kind of thing, with no single anchor, starts from a list instead: `await semiont.browse.resources({ entityType: 'Case', limit: 1000 }).fresh()`, then `browse.annotations(id).fresh()` for each resource.

## Step 3: an excerpt for each reference

`gather.annotation` gives the passage a reference sits in. It is one request to the knowledge base for each reference, so skip it for a report that only lists its sources.

```typescript
import type { AnnotationId, ResourceId } from '@semiont/sdk';

async function excerpt(source: ResourceId, reference: AnnotationId): Promise<string> {
  const gathered = await semiont.gather.annotation(source, reference, { contextWindow: 1500 });
  const focus = gathered.response.focus;
  if (focus.kind !== 'annotation' || !focus.selected) return '';
  const { before, text, after } = focus.selected;
  return `${before ?? ''}${text}${after ?? ''}`.replace(/\s+/g, ' ').trim();
}
```

## Steps 4 and 5: compose and yield

The body is the deliverable, so give it a shape: a title, a line saying what it was built from and when, the table, and any findings.

```typescript
const anchorName = 'Citizens United v. FEC';
const rows = [
  { source: 'res-speechnow', name: 'SpeechNow.org v. FEC', quote: 'under Citizens United' },
];

const lines = [
  `# Subsequent treatment: ${anchorName}`,
  '',
  `Built from ${rows.length} citing passages on ${new Date().toISOString().slice(0, 10)}.`,
  '',
  '| # | Citing resource | Passage |',
  '|---|---|---|',
  ...rows.map((row, i) => `| ${i + 1} | [${row.name}](${row.source}) | ${row.quote} |`),
];
const body = `${lines.join('\n')}\n`;

const slug = anchorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
const { resourceId: aggregateId } = await semiont.yield.resource({
  name: `Subsequent treatment: ${anchorName}`,
  file: Buffer.from(body, 'utf-8'),
  format: 'text/markdown',
  entityTypes: ['SubsequentTreatment', 'Aggregate'],
  storageUri: `file://generated/treatment-${slug}-${Date.now()}.md`,
});

console.log(`Aggregate created: ${aggregateId}`);
```

With `Aggregate` on every one, `browse.resources({ entityType: 'Aggregate' })` lists a knowledge base's aggregates whatever their kind.

## Complete script

```typescript
import {
  SemiontSession, InMemorySessionStorage, httpKb, resourceId,
} from '@semiont/sdk';

const INCLUDE_EXCERPTS = process.env.INCLUDE_GATHER !== '0';

async function aggregate(anchorIdStr: string): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-aggregate', label: 'Semiont',
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
    // 1. The anchor
    const anchorId = resourceId(anchorIdStr);
    const anchor = await semiont.browse.resource(anchorId).fresh();

    // 2. What refers to it
    const references = await semiont.gather.referencedBy(anchorId).fresh();

    // 3. An excerpt for each, when the report quotes its sources
    const rows: Array<{ source: string; name: string; quote: string }> = [];
    for (const ref of references) {
      let quote = ref.target.selector.exact;
      if (INCLUDE_EXCERPTS) {
        const gathered = await semiont.gather.annotation(ref.target.source, ref.id, { contextWindow: 1500 });
        const focus = gathered.response.focus;
        if (focus.kind === 'annotation' && focus.selected) {
          const { before, text, after } = focus.selected;
          quote = `${before ?? ''}${text}${after ?? ''}`.replace(/\s+/g, ' ').trim();
        }
      }
      rows.push({ source: ref.target.source, name: ref.resourceName, quote: quote.replace(/\|/g, '\\|') });
    }

    // 4. Compose
    const lines = [
      `# Aggregate: ${anchor.name}`,
      '',
      `Built from ${rows.length} passages that refer to it, on ${new Date().toISOString().slice(0, 10)}.`,
      '',
      '| # | Source | Passage |',
      '|---|---|---|',
      ...rows.map((row, i) => `| ${i + 1} | [${row.name}](${row.source}) | ${row.quote} |`),
    ];
    const body = `${lines.join('\n')}\n`;

    // 5. Yield
    const slug = anchor.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80);
    const { resourceId: aggregateId } = await semiont.yield.resource({
      name: `Aggregate: ${anchor.name}`,
      file: Buffer.from(body, 'utf-8'),
      format: 'text/markdown',
      entityTypes: ['Aggregate'],
      storageUri: `file://generated/aggregate-${slug}-${Date.now()}.md`,
    });

    console.log(`Aggregate created: ${aggregateId} (${rows.length} rows)`);
  } finally {
    await session.dispose();
  }
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx aggregate.ts <anchorResourceId>');
  process.exit(1);
}
aggregate(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Ask the node-or-aggregate question first.** If annotations should point at the new resource, it is a canonical node and the skill is [`semiont-wiki`](../semiont-wiki/SKILL.md).
- **Choose the anchor on purpose.** One resource (a case, a work, a person) makes `gather.referencedBy` the whole collection step. A kind of thing or a theme means listing resources with `browse.resources({ entityType })` and reading each one's annotations.
- **An aggregate is a dated snapshot.** A new run writes a new resource; the timestamp in its `storageUri` keeps the earlier ones. A single resource that is kept current is a canonical node.
- **Excerpts cost a request each.** A checklist that names its sources does not need them. The script reads `INCLUDE_GATHER=0` to skip them.
- **Stamp the kind and `Aggregate`.** `['SubsequentTreatment', 'Aggregate']`, `['PlotArc', 'Aggregate']`.
- **Write for a reader.** Title, summary, table or list, findings. When the aggregate cites authorities outside the knowledge base, end it with an `## External references` section that lists each one as a titled link.
- **Filter by what the reference says.** A reference's own annotation carries its entity type, and its resource may carry tags and assessments. Read them with `browse.annotations(ref.target.source).fresh()` to sort or group the rows.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. See [Error Handling](../../Usage.md#error-handling).
