---
name: semiont-relate
description: Extract relationships between canonical nodes — run a second mark.assist linking pass after the node set exists, with relationship-vocabulary instructions, so the resulting annotations link two nodes apiece
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user wire edges into a Semiont knowledge base. After [`semiont-wiki`](../semiont-wiki/SKILL.md) (or another canonicalize-mentions pass) has produced the **node set** — Character resources, Party resources, Place resources, Case resources — the next step is to discover the **edges**: who is whose mother, which party is the counterparty under a contract, where a character was exiled to, which judge wrote which opinion. This skill runs that second pass.

This skill builds **Layer #4 (Edges)** of the layered data model. An edge in Semiont is not a separate kind of artifact — it is an *annotation* that physically lives on a primary-material span (the passage where the relationship is established in the text), but whose body items reference two Layer-#3 canonical nodes. The "edge layer" is the *role* such annotations play. Examples:

- A kinship link between two Person nodes anchored on the biography passage that establishes it.
- A counterparty link between two Party nodes anchored on the contract clause that names them.
- A character–place link anchored on the literary passage that places the character at the place.
- A judge–court link anchored on the opinion's signature line.

## Prerequisite: declare the relationship vocabulary via `frame.addEntityTypes`

If you want the relationship type to be a queryable entity-type tag (e.g., so `browse.entityTypes()` surfaces `kinship`, `counterparty`, `mentorship` as part of the published vocabulary), declare those tag values via `semiont.frame.addEntityTypes([...])` before running this skill. This is normally done once, at corpus ingest, by [`semiont-ingest`](../semiont-ingest/SKILL.md) — its `KB_ENTITY_TYPES` constant should already enumerate the relationship types. If it doesn't, declare them explicitly:

```typescript
await semiont.frame.addEntityTypes([
  'kinship', 'patronage', 'antagonism', 'alliance',           // mythological / dramatic
  'counterparty', 'employer-employee', 'lessor-lessee',       // legal / commercial
  'judge-of-court', 'attorney-for-client',                    // judicial
  'born-in', 'exiled-to', 'imprisoned-at',                    // character ↔ place
]);
```

Skipping this declaration "works" if you only encode relationships as inline tag-body values — but the schema layer doesn't know the vocabulary exists, and `browse.entityTypes()` returns an accumulated drift instead of a coherent published set.

## Two shapes for edges

A relationship can be encoded as one annotation in two ways. Both are valid; the choice depends on whether downstream skills want to query relationships individually or aggregate over them.

**Shape A — Inline tagging body.** One linking annotation on the source passage; the body has two `SpecificResource` items (one per related node) and one `TextualBody` with `purpose: 'tagging'` carrying the relationship-type tag value (`kinship`, `counterparty`, `born-in`, etc.). This is the lighter shape; the relationship lives entirely on the annotation.

**Shape B — Synthesized Relationship resource.** One linking annotation on the source passage with `SpecificResource` items pointing at *both* the two related nodes *and* a synthesized **Relationship resource** (entity types `[Relationship, '<RelationType>']`). The Relationship resource is itself a small canonical node that aggregates all the source spans for one specific relationship pair (e.g., "Prometheus → kinship → Iapetus" gets one Relationship resource that gathers every passage establishing it). This is heavier but more queryable.

Shape A is right for sparse relationships where the per-passage mention is the artifact you want. Shape B is right when the same pair recurs across many passages and the user wants a single navigable resource for "the relationship between X and Y."

## Client setup

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
```

For long-running scripts that may span token expiry, use `SemiontSession.signInHttp(...)` instead.

## Step 1 — Run the relationship-extraction pass

Use `mark.assist` with motivation `linking` and an instruction string that names the relationship vocabulary explicitly. The model walks the corpus and tags spans where two named entities (already canonicalized as Layer-#3 nodes by an earlier pass) appear in a relationship.

```typescript
const RELATIONSHIP_INSTRUCTIONS = `
For pairs of named parties that already appear as canonical resources in this KB,
identify any explicit relationship and tag the span where the relationship is established.
Use one tag value per relationship from the controlled vocabulary:
  - kinship          (parent / child / sibling / spouse)
  - patronage        (god ↔ mortal, mentor ↔ protege, master ↔ servant)
  - antagonism       (adversaries, opponents, captor ↔ captive)
  - alliance         (allies, partners)
  - counterparty     (the two formal parties to a contract or agreement)
  - employer-employee
  - born-in          (character / person ↔ place)
  - exiled-to        (character ↔ place)
  - imprisoned-at    (character ↔ place)
The body of each annotation should reference the two canonical resources by id.
`.trim();

const rId = resourceId('passage-or-document-id');

const progress = await semiont.mark.assist(rId, 'linking', {
  instructions: RELATIONSHIP_INSTRUCTIONS,
});

console.log(`Created ${progress.progress?.createdCount ?? 0} relationship annotations`);
```

The relationship annotations land on Layer #2 with bodies that reach up to Layer #3.

## Step 2 (optional, Shape B only) — Synthesize Relationship resources

When the same relationship pair recurs across many passages and you want a single navigable resource per pair, walk the relationship annotations, group by `(node-A, node-B, relationship-type)` triples, and yield one Relationship resource per distinct triple.

```typescript
import { type AnnotationId, type ResourceId } from '@semiont/sdk';

interface RelationshipHit {
  rId: ResourceId;
  annId: AnnotationId;
  nodeA: string;
  nodeB: string;
  type: string;
  spanText: string;
}

// Walk relationship annotations across the corpus
const allDocs = await semiont.browse.resources({ limit: 1000 });
const hits: RelationshipHit[] = [];

for (const doc of allDocs) {
  const docId = resourceId(doc['@id']);
  const annotations = await semiont.browse.annotations(docId);
  for (const ann of annotations) {
    if (ann.motivation !== 'linking') continue;
    const tags = (ann.body ?? [])
      .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
      .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
    const refs = (ann.body ?? [])
      .filter((b: any) => b.type === 'SpecificResource' && b.purpose === 'linking')
      .map((b: any) => b.source as string);
    if (refs.length !== 2 || tags.length === 0) continue;

    const [nodeA, nodeB] = refs.sort(); // canonicalize pair-order
    for (const type of tags) {
      hits.push({
        rId: docId,
        annId: ann.id,
        nodeA,
        nodeB,
        type,
        spanText: ann.target?.selector?.exact ?? '',
      });
    }
  }
}

// Group by (nodeA, nodeB, type) triple
const byTriple = new Map<string, RelationshipHit[]>();
for (const hit of hits) {
  const key = `${hit.nodeA}|${hit.nodeB}|${hit.type}`;
  if (!byTriple.has(key)) byTriple.set(key, []);
  byTriple.get(key)!.push(hit);
}

// Yield one Relationship resource per distinct triple
for (const [key, members] of byTriple) {
  const [nodeA, nodeB, type] = key.split('|');
  const body =
    `# Relationship: ${type}\n\n` +
    `Between [${nodeA}](${nodeA}) and [${nodeB}](${nodeB}).\n\n` +
    `Established in ${members.length} passage(s):\n\n` +
    members.map((m) => `- "${m.spanText}"`).join('\n') +
    '\n';

  await semiont.yield.resource({
    name: `${type}: ${nodeA} ↔ ${nodeB}`,
    file: Buffer.from(body, 'utf-8'),
    format: 'text/markdown',
    entityTypes: ['Relationship', type],
    storageUri: `file://generated/relationship-${type}-${Date.now()}.md`,
  });
}
```

The synthesized Relationship resources are themselves small canonical nodes (Layer #3 by shape, even though they describe edges); other annotations could in principle bind to them, though in practice they are usually terminal. They give downstream skills a single resource to walk per pair, instead of re-grouping annotations every time.

## Complete script skeleton (Shape A — inline tagging only)

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

const RELATIONSHIP_INSTRUCTIONS = process.env.RELATIONSHIP_INSTRUCTIONS ?? `
For pairs of named entities that already exist as canonical resources in this KB,
identify any explicit relationship and tag the span where it is established. Use one tag
value per relationship from your KB's relationship vocabulary (e.g., kinship, counterparty,
employer-employee, born-in, exiled-to). The annotation body should reference the two
canonical resources by id.
`.trim();

async function wireEdges(resourceIdStr: string): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });
  const rId = resourceId(resourceIdStr);

  const progress = await semiont.mark.assist(rId, 'linking', {
    instructions: RELATIONSHIP_INSTRUCTIONS,
  });

  console.log(`Created ${progress.progress?.createdCount ?? 0} relationship annotations`);
  semiont.dispose();
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx relate.ts <resourceId>');
  process.exit(1);
}
wireEdges(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Run after the node set exists.** This skill assumes Layer #3 is populated. Run [`semiont-wiki`](../semiont-wiki/SKILL.md) (or whatever canonicalize-mentions skill the KB uses) first, so the model has named canonical resources to point relationships at. Running this pass against a corpus with no canonical nodes produces relationship annotations whose body items have nothing to reference.
- **The relationship vocabulary is corpus-defined.** Common patterns: kinship + patronage + antagonism (literary / mythological); counterparty + lessor-lessee + employer-employee (legal / commercial); judge-of-court + attorney-for-client (judicial); born-in + exiled-to + imprisoned-at (character ↔ place). Pick a vocabulary that matches the corpus; declare it via `frame.addEntityTypes` so it's a queryable published set.
- **Shape A vs. Shape B.** Default to Shape A (inline tagging body, no Relationship resource). Move to Shape B when the same pair recurs across many passages and you want a single resource that aggregates every establishment. Shape B's Relationship resources are entity-typed `[Relationship, <type>]` so they're queryable as a class.
- **Edges are sparse, not dense.** In practice this skill produces fewer annotations than the underlying detection passes — a 100-passage corpus might yield 20-50 relationship annotations, not hundreds. If you're getting suspiciously dense edges, the model is probably tagging same-document co-occurrence (any two characters appearing in one paragraph) rather than explicit relationships. Tighten the instructions.
- **Edges feed `semiont-aggregate`.** When you want a graph-shaped view (a PrecedentGraph for caselaw, a kinship-tree for biographical work), an aggregate skill walks the edge annotations and composes the graph view. See [`semiont-aggregate`](../semiont-aggregate/SKILL.md) for the aggregate-composition pattern.
- **Only `text/plain` and `text/markdown` resources are supported** for `mark.assist`. PDFs and images are not yet supported.
- **Check results** with `semiont.browse.annotations(rId)` — filter for `motivation === 'linking'` and inspect each annotation's body items to see which pairs of nodes the model linked.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
