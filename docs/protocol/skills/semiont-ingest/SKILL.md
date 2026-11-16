---
name: semiont-ingest
description: Bootstrap a Semiont knowledge base from a corpus of source files — declare the entity-type vocabulary via frame, then upload one resource per file via yield.resource
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user ingest a corpus into a Semiont knowledge base. This is the foundation operation every KB starts with: declare the published entity-type vocabulary, then upload the source files as Resources. After ingest, the corpus is queryable via `browse.resources(...)` and ready for the detection / canonicalization / aggregation passes that build the rest of the KB's layered data model.

This skill builds **Layer #1 (Primary Material)** — the ground truth that every subsequent layer points back to. Without it, nothing else moves.

## Two operations, in order

1. **Declare the vocabulary** via `semiont.frame.addEntityTypes([...])`. This publishes the KB's entity-type set on the `frame:add-entity-type` channel; downstream `browse.entityTypes()` queries see a coherent vocabulary instead of an accumulating set of strings stamped implicitly. The list is a per-KB constant, declared once at the top of the ingest script.
2. **Upload the corpus** via `semiont.yield.resource({...}) × N`. One call per source file. Each Resource carries a `format` (media type), `entityTypes` (its kind), `name` (display label), `storageUri` (a stable identifier — `file://...` or another scheme), and a `file` body (a Buffer of the content).

Both operations are idempotent on the schema side (declaring an already-declared entity type is a no-op) but **not** on the resource side (re-running creates duplicate resources unless the script de-dupes by name or storageUri first).

## Client setup

`SemiontClient.signInHttp(...)` is the credentials-first one-line construction for one-shot scripts. Construct once and reuse for both `frame` and `yield` calls.

```typescript
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
```

For long-running ingests that may span token expiry, use `SemiontSession.signInHttp(...)` instead.

## Step 1 — Declare the entity-type vocabulary

The vocabulary is **every entity type the KB will use across all of its skills**, not just the resource-level types from this ingest. Detection skills (linking / assessing / commenting / tagging) attach entity-type tags as annotation body values; aggregator skills synthesize new entity-type-bearing resources. Declaring everything upfront is what makes the schema layer a published artifact rather than implicit.

```typescript
const KB_ENTITY_TYPES = [
  // Resource-level types (used by yield.resource calls in this skill)
  'Case',
  'JudicialOpinion',
  'StateCourt',
  'SupremeCourt',
  // Detection-pass entity types (used downstream by mark.assist)
  'Person',
  'Judge',
  'Plaintiff',
  'Defendant',
  'Counsel',
  // Synthesized aggregate types (used downstream by yield.resource composing markdown)
  'Party',
  'PrecedentGraph',
  'SubsequentTreatment',
  'DoctrinalTrace',
  'Aggregate',
  // ... etc.
];

await semiont.frame.addEntityTypes(KB_ENTITY_TYPES);
console.log(`Declared ${KB_ENTITY_TYPES.length} entity types via frame.`);
```

Centralizing the list at the top of the ingest script — and keeping it as the single source of truth — is the discipline that makes future skills know what vocabulary they can operate against.

## Step 2 — Upload the corpus

For each source file:

```typescript
import { readFileSync } from 'node:fs';

const file = {
  path: 'corpus/case-001.md',
  name: 'State v. Smith (2018)',
  format: 'text/markdown',
  entityTypes: ['Case', 'JudicialOpinion', 'StateCourt'],
  storageUri: 'file://corpus/case-001.md',
};

const buffer = readFileSync(file.path);
const { resourceId } = await semiont.yield.resource({
  name: file.name,
  file: buffer,
  format: file.format,
  entityTypes: file.entityTypes,
  storageUri: file.storageUri,
});

console.log(`+ ${file.path} → ${resourceId}`);
```

The `format` controls what downstream skills can do: `text/markdown` and `text/plain` resources are eligible for `mark.assist` (model-driven detection); `application/pdf` and other binary formats are cataloged but not yet text-analyzable. The `entityTypes` are the resource's kinds — they classify the resource for `browse.resources({ entityType: ... })` queries and for any skill that needs to filter the corpus by document kind.

## Complete script skeleton

```typescript
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { SemiontClient } from '@semiont/sdk';

// === The KB's published entity-type vocabulary ===
const KB_ENTITY_TYPES = [
  // Resource-level
  'Case',
  'JudicialOpinion',
  'StateCourt',
  'SupremeCourt',
  // Detection-pass entity types (used by downstream mark.assist skills)
  'Person',
  'Judge',
  'Plaintiff',
  'Defendant',
  'Counsel',
  // Synthesized aggregate types (used by downstream aggregator skills)
  'Party',
  'PrecedentGraph',
  'SubsequentTreatment',
  'Aggregate',
];

interface CorpusFile {
  path: string;
  name: string;
  format: string;
  entityTypes: string[];
  storageUri: string;
}

function discoverCorpus(repoRoot: string): CorpusFile[] {
  // Replace this with your corpus's actual layout. The pattern shown walks a
  // single subdirectory of markdown files; a real ingest typically classifies
  // files by directory + filename heuristics.
  const dir = join(repoRoot, 'corpus');
  const out: CorpusFile[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    const ext = extname(entry).toLowerCase();
    if (ext !== '.md' && ext !== '.txt') continue;
    out.push({
      path: relative(repoRoot, full),
      name: entry.replace(/\.(md|txt)$/, '').replace(/[_-]/g, ' '),
      format: ext === '.md' ? 'text/markdown' : 'text/plain',
      entityTypes: ['Case', 'JudicialOpinion', 'StateCourt'],
      storageUri: `file://${relative(repoRoot, full)}`,
    });
  }
  return out;
}

async function ingest(): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });

  // Step 1 — declare the vocabulary
  console.log(`Declaring ${KB_ENTITY_TYPES.length} entity types via frame...`);
  await semiont.frame.addEntityTypes(KB_ENTITY_TYPES);

  // Step 2 — discover and upload
  const files = discoverCorpus(process.cwd());
  console.log(`Discovered ${files.length} corpus file(s).`);

  let created = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const buffer = readFileSync(file.path);
      const { resourceId } = await semiont.yield.resource({
        name: file.name,
        file: buffer,
        format: file.format,
        entityTypes: file.entityTypes,
        storageUri: file.storageUri,
      });
      created++;
      console.log(`  + ${file.path} → ${resourceId}`);
    } catch (e) {
      failed++;
      console.warn(`  ! ${file.path} failed: ${(e as Error).message}`);
    }
  }

  console.log(`Done. ${created} resources created, ${failed} failed.`);
  semiont.dispose();
}

ingest().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Declare the vocabulary upfront.** Skipping `frame.addEntityTypes` and just stamping entity-type strings on resources / annotations as you go "works" in the lenient sense — the strings get attached. But `browse.entityTypes()` then returns an accumulated drift instead of a coherent published set. Declare the full vocabulary in a `KB_ENTITY_TYPES` constant at the top of the ingest script.
- **The vocabulary is per-KB, not per-skill.** Include every entity type any skill in the KB will use — resource-level types, detection-pass entity types, synthesized-aggregate types. The ingest script is the natural single source of truth for the published set.
- **Re-running creates duplicate resources.** This skill does not deduplicate. To re-ingest cleanly, restart the backend stack, or query existing resources via `browse.resources({ search: '<name>' })` and skip ones already present.
- **Classify carefully by entity type.** A markdown contract should be `entityTypes: ['Contract']` not `['Document']`; a judicial opinion should be `['Case', 'JudicialOpinion', 'StateCourt']` not just `['Case']`. Downstream skills filter the corpus by these tags; ambiguous classification at ingest produces ambiguous queries later.
- **PDFs are cataloged, not analyzed.** A resource with `format: 'application/pdf'` is queryable via `browse.resources(...)` but cannot be the target of `mark.assist`. PDF-to-markdown conversion is a separate operation; if the user needs body-content analysis on PDFs, ingest a markdown sibling alongside the PDF.
- **`storageUri` is a stable identifier.** Use `file://<path>` for files in the repo, or another scheme for content from external sources. The URI is preserved across re-runs and is what other skills can use to trace a resource back to its origin.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
