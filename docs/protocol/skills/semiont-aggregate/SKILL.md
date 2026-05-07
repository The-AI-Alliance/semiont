---
name: semiont-aggregate
description: Compose a synthesized aggregate resource — walk many annotations bound to or about a single anchor, assemble markdown, yield a Resource whose purpose is to be read (not referred to)
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user compose an **aggregate resource** — a synthesized markdown artifact that summarizes a slice of the knowledge base. Aggregates are the deliverable form of a Semiont KB: an Investigation summarizing a resolution audit, a PlotArc tracing narrative structure, a SubsequentTreatment classifying citing cases, a DoctrinalTrace memo, a Timeline of dated events, a Checklist of pending items.

This skill builds **Layer #5 (Aggregates)** of the layered data model. The aggregate's purpose is to be *read* — by humans, or queried by downstream tools — not to be referred to by other annotations. That distinction is the cleanest dividing line between this skill and [`semiont-wiki`](../semiont-wiki/SKILL.md), which builds **Layer #3 (Canonical Nodes)** — resources whose purpose is to *be referred to*.

## When to use this skill (vs. `semiont-wiki`)

The skill-design test, in one line: **will other annotations point at the new resource?**

- If yes → use [`semiont-wiki`](../semiont-wiki/SKILL.md). You are building a node in the KB's graph; it canonicalizes some scattered mentions into a single resource that future detection passes can resolve to.
- If no → use this skill. You are building a deliverable. The resource is a memo, table, or summary that someone reads; nothing else points at it.

A few skills run both in sequence: canonicalize first, then aggregate the audit at the end. When chained, the order is always *canonicalize → aggregate*: build the references, then write the report about what you built.

## The shape

An aggregate skill walks the KB to gather material *about* an anchor, composes markdown, and yields the result.

1. **Identify the anchor.** A target case, a literary work, a doctrine query, a matter, a Subject. Sometimes given as a CLI argument; sometimes inferred from the corpus.
2. **Gather material from lower layers.** Walk annotations bound to or about the anchor (Layer #2). Follow them up to canonical nodes (Layer #3). Read edges where they exist (Layer #4). For aggregates that need source-passage excerpts, call `gather.annotation` per item.
3. **Compose markdown.** Assemble a structured document — table of items, narrative sections, citation list, External References block.
4. **Yield the resource.** `yield.resource({...})` with `entityTypes: [<AggregateKind>, 'Aggregate']`, a stable `storageUri`, and the composed markdown as the file body.

Re-running an aggregate skill produces a *new* aggregate alongside the prior one (typically dated in the storageUri so successive runs become a comparable record). The skill does not in-place update prior aggregates — that would lose the snapshot history.

## Prerequisite: declare the aggregate entity types via `frame.addEntityTypes`

The synthesized resource is stamped with `entityTypes: [<AggregateKind>, 'Aggregate']` — e.g. `['Investigation', 'Aggregate']`, `['PlotArc', 'Aggregate']`, `['SubsequentTreatment', 'Aggregate']`. Both the specific kind *and* the umbrella `Aggregate` tag must be in the KB's published entity-type vocabulary, declared via `semiont.frame.addEntityTypes([...])`. This is normally done once, at corpus ingest, by the [`semiont-ingest`](../semiont-ingest/SKILL.md) skill — its `KB_ENTITY_TYPES` constant should already enumerate every aggregate kind the KB synthesizes.

If you are introducing a new aggregate kind that wasn't declared at ingest time, declare it explicitly before the `yield.resource` call:

```typescript
await semiont.frame.addEntityTypes(['SubsequentTreatment', 'Aggregate']);
```

Skipping the declaration means the aggregate's entity-type stamps end up implicit rather than published — `browse.resources({ entityType: 'SubsequentTreatment' })` may still find the resource on a lenient backend, but the schema layer doesn't know the type exists.

## Client setup

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
```

## Step 1 — Identify the anchor and gather material

Most aggregate skills are anchored to a single resource (or a single conceptual query). The first task is to find the relevant annotations.

```typescript
const targetId = resourceId(process.argv[2]);

// Read the annotations on the target
const annotations = await semiont.browse.annotations(targetId);

// Or, more commonly, walk the corpus for annotations *referring to* the target
const allCases = await semiont.browse.resources({ limit: 1000 });
const citingHits: Array<{ caseId: string; ann: any }> = [];
for (const c of allCases) {
  if (c['@id'] === targetId) continue;
  const cAnns = await semiont.browse.annotations(resourceId(c['@id']));
  for (const ann of cAnns) {
    const refs = (ann.body ?? [])
      .filter((b: any) => b.type === 'SpecificResource' && b.purpose === 'linking')
      .map((b: any) => b.source);
    if (refs.includes(targetId as string)) {
      citingHits.push({ caseId: c['@id'], ann });
    }
  }
}
```

## Step 2 — Optionally gather context per item

When the aggregate's rows need source-passage excerpts, call `gather.annotation` per item to fetch the surrounding text. Be aware this is O(N) LLM context-fetches; for large aggregates use a flag like `INCLUDE_GATHER=0` to skip excerpt-fetching when the user only needs the structure.

```typescript
const INCLUDE_GATHER = process.env.INCLUDE_GATHER !== '0';

for (const hit of citingHits) {
  if (!INCLUDE_GATHER) continue;
  const gather = await semiont.gather.annotation(hit.ann.id, resourceId(hit.caseId), {
    contextWindow: 1500,
  });
  hit.context = gather.response;
}
```

## Step 3 — Compose markdown

Build the body from the gathered material. Aggregates typically have:

- A title line (the anchor's name)
- A summary paragraph (what was walked, when generated)
- A primary table or list (one row per item, with provenance link back to the source)
- Optional narrative section(s) (highlighted findings, negative-treatment language, foundational cases, …)
- An External References section listing canonical real-world authorities cited

```typescript
const lines: string[] = [
  `# Subsequent treatment: ${targetName}`,
  '',
  `Auto-generated treatment report for [${targetName}](${targetId}). ` +
    `Generated: ${new Date().toISOString()}.`,
  '',
  `**Citing cases analyzed:** ${citingHits.length}.`,
  '',
  '## Treatment table',
  '',
  '| # | Citing case | Treatment | Resource |',
  '|---|---|---|---|',
];
citingHits.forEach((hit, i) => {
  lines.push(`| ${i + 1} | ${hit.caseName} | ${hit.treatment} | [${hit.caseId}](${hit.caseId}) |`);
});
const body = lines.join('\n') + '\n';
```

## Step 4 — Yield the aggregate resource

```typescript
const slug = targetName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
const { resourceId: aggregateId } = await semiont.yield.resource({
  name: `Subsequent treatment: ${targetName}`,
  file: Buffer.from(body, 'utf-8'),
  format: 'text/markdown',
  entityTypes: ['SubsequentTreatment', 'Aggregate'],
  storageUri: `file://generated/treatment-${slug}-${Date.now()}.md`,
});

console.log(`Aggregate created: ${aggregateId} (${body.length} bytes)`);
semiont.dispose();
```

The `entityTypes` always include both the specific aggregate kind (`SubsequentTreatment`, `PlotArc`, `Investigation`, `Timeline`, etc.) and the umbrella `Aggregate` tag, so `browse.resources({ entityType: 'Aggregate' })` lists every aggregate in the KB regardless of kind.

## Complete script skeleton

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

const INCLUDE_GATHER = process.env.INCLUDE_GATHER !== '0';

async function aggregate(anchorIdStr: string): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });
  const anchorId = resourceId(anchorIdStr);

  // 1. Identify the anchor
  const all = await semiont.browse.resources({ limit: 1000 });
  const anchor = all.find((r) => r['@id'] === anchorIdStr);
  if (!anchor) throw new Error(`Anchor ${anchorIdStr} not found`);
  const anchorName = anchor.name ?? anchorIdStr;

  // 2. Walk annotations bound to / about the anchor
  type Hit = { sourceId: string; sourceName: string; ann: any; context?: any };
  const hits: Hit[] = [];
  for (const r of all) {
    if (r['@id'] === anchorIdStr) continue;
    const anns = await semiont.browse.annotations(resourceId(r['@id']));
    for (const ann of anns) {
      const refs = (ann.body ?? [])
        .filter((b: any) => b.type === 'SpecificResource' && b.purpose === 'linking')
        .map((b: any) => b.source as string);
      if (refs.includes(anchorIdStr)) {
        hits.push({ sourceId: r['@id'], sourceName: r.name ?? r['@id'], ann });
      }
    }
  }

  // 3. Optionally gather context
  if (INCLUDE_GATHER) {
    for (const hit of hits) {
      const gather = await semiont.gather.annotation(
        hit.ann.id,
        resourceId(hit.sourceId),
        { contextWindow: 1500 },
      );
      hit.context = gather.response;
    }
  }

  // 4. Compose markdown
  const lines: string[] = [
    `# Aggregate report: ${anchorName}`,
    '',
    `Auto-generated. Generated: ${new Date().toISOString()}.`,
    '',
    `**Items aggregated:** ${hits.length}.`,
    '',
    '## Items',
    '',
    '| # | Source | Resource |',
    '|---|---|---|',
  ];
  hits.forEach((hit, i) => {
    lines.push(`| ${i + 1} | ${hit.sourceName} | [${hit.sourceId}](${hit.sourceId}) |`);
  });
  const body = lines.join('\n') + '\n';

  // 5. Yield the aggregate
  const slug = anchorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80);
  const { resourceId: aggregateId } = await semiont.yield.resource({
    name: `Aggregate: ${anchorName}`,
    file: Buffer.from(body, 'utf-8'),
    format: 'text/markdown',
    entityTypes: ['Aggregate'],
    storageUri: `file://generated/aggregate-${slug}-${Date.now()}.md`,
  });

  console.log(`Aggregate created: ${aggregateId} (${body.length} bytes)`);
  semiont.dispose();
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

- **The #3-vs-#5 test.** Before writing an aggregate skill, confirm the new resource is a deliverable (read by humans) and *not* something other annotations should point at. If other annotations should point at it, you are writing [`semiont-wiki`](../semiont-wiki/SKILL.md) (Layer #3), not this skill.
- **Pick the anchor type intentionally.** Some aggregates are anchored to one specific resource (a target case, a literary work, a Subject); some are anchored to a corpus-wide query (a doctrine, a theme); some are anchored to "the matter" (every annotation in a scope). The anchor shape determines the loop in step 1 — single-target aggregates are quick reads; corpus-wide aggregates need browse.resources walks.
- **Aggregates are dated, not in-place updated.** Re-running a treatment / trace / timeline produces a *new* aggregate alongside the prior. The pattern is `storageUri: file://generated/<kind>-<slug>-${Date.now()}.md` — the timestamp keeps prior runs alongside the current. If you want a single canonical aggregate that overwrites, that's not this archetype; you want canonicalize-mentions instead.
- **Gather is optional but expensive.** Calling `gather.annotation` per item adds O(N) LLM context-fetches. For aggregates that don't need source-passage excerpts (a Checklist that just lists action items by source resource is fine without per-item context), skip it. The `INCLUDE_GATHER` env flag is the convention.
- **Always include the `Aggregate` umbrella tag** alongside the specific aggregate kind. `entityTypes: ['SubsequentTreatment', 'Aggregate']`, `entityTypes: ['PlotArc', 'Aggregate']`, etc. This lets `browse.resources({ entityType: 'Aggregate' })` list every aggregate in the KB regardless of kind.
- **External References belong at the bottom of the body.** When the aggregate cites real-world authorities (Wikipedia, CourtListener, US Code), include an `## External references` section as a markdown bullet list of `[Title](URL) — Source` lines. This is the durable convention for the External Authorities peer layer.
- **Composition matters.** Aggregates are read by humans (or by other tools that consume markdown). Structure the body — title, summary paragraph, primary table or list, narrative findings, external references — rather than dumping a raw flat list of items. The markdown is the deliverable.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
