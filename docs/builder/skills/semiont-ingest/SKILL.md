---
name: semiont-ingest
description: Bootstrap a Semiont knowledge base from a corpus of source files — declare the entity-type vocabulary via frame, then upload one resource per file via yield.resource
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user ingest a corpus into a Semiont knowledge base. Every knowledge base starts here: declare the vocabulary of entity types, then make each source file a resource. After ingest the corpus can be browsed, and the detection, canonicalization and aggregation skills have something to work on.

This skill builds the primary-material layer of [the layered data model](../README.md#the-layers): the documents every later layer points back to.

## Two operations, in order

1. **Declare the vocabulary** with `semiont.frame.addEntityTypes([...])`. The list belongs to the knowledge base, and the ingest script is where it is written down.
2. **Upload the corpus** with `semiont.yield.resource({...})`, once for each file. A resource has a `name` (what people see), a `format` (its media type), `entityTypes` (what kind of document it is), a `storageUri` (where its file lives in the knowledge base's working tree) and a `file` (its bytes).

Declaring an entity type that is already declared changes nothing. Uploading is not like that: nothing in an upload checks whether its file is already a resource, so a script that runs twice must skip what is there. The complete script below does.

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs) and an ingest can run longer, so use a session, not a bare client. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-ingest', label: 'Semiont',
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

## Step 1: declare the entity types

Declare every entity type any skill in the knowledge base will use, not only the kinds of document this ingest uploads. Detection skills name entity types on the references they create, and aggregating skills stamp them on the resources they compose. A detection or generation job that names a type nobody declared is refused, and `browse.entityTypes()`, where the Browser and other skills read the vocabulary, lists only what was declared.

```typescript
const KB_ENTITY_TYPES = [
  // What the uploaded documents are
  'Case', 'JudicialOpinion', 'StateCourt', 'SupremeCourt',
  // What detection will look for
  'Person', 'Judge', 'Plaintiff', 'Defendant', 'Counsel',
  // What later skills will compose
  'Party', 'PrecedentGraph', 'SubsequentTreatment', 'DoctrinalTrace', 'Aggregate',
];

await semiont.frame.addEntityTypes(KB_ENTITY_TYPES);
console.log(`Declared ${KB_ENTITY_TYPES.length} entity types`);
```

## Step 2: upload the corpus

```typescript
import { readFileSync } from 'node:fs';

const file = {
  path: 'corpus/case-001.md',
  name: 'State v. Smith (2018)',
  format: 'text/markdown',
  entityTypes: ['Case', 'JudicialOpinion', 'StateCourt'],
};

const { resourceId } = await semiont.yield.resource({
  name: file.name,
  file: readFileSync(file.path),
  format: file.format,
  entityTypes: file.entityTypes,
  storageUri: `file://${file.path}`,
});

console.log(`+ ${file.path} is ${resourceId}`);
```

`storageUri` is `file://` followed by the file's path in the knowledge base's working tree. The upload puts the bytes there, so a corpus that is already in the repository keeps its paths. The event an upload appends under `.semiont/events/` is the record of the resource: commit it with the file.

`format` decides what later skills can do with the resource. `mark.delegate` reads Markdown, plain text, HTML, JSON and PDF, and an image can be annotated by hand. [Media Types](../../../architecture/MEDIA-TYPES.md) has the whole table.

`entityTypes` say what kind of document a resource is. `browse.resources({ entityType })` filters on them, and so does every skill that works on one kind of document.

## Complete script

Run it from the knowledge base's root. It uploads the Markdown and text files in `corpus/` and skips the ones that are already resources.

```typescript
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const KB_ENTITY_TYPES = [
  'Case', 'JudicialOpinion', 'StateCourt', 'SupremeCourt',
  'Person', 'Judge', 'Plaintiff', 'Defendant', 'Counsel',
  'Party', 'PrecedentGraph', 'SubsequentTreatment', 'Aggregate',
];

const CORPUS_DIR = 'corpus';
const FORMATS: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain' };

async function ingest(): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-ingest', label: 'Semiont',
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
    // Step 1: declare the vocabulary
    await semiont.frame.addEntityTypes(KB_ENTITY_TYPES);
    console.log(`Declared ${KB_ENTITY_TYPES.length} entity types`);

    // Step 2: upload each file that is not a resource yet
    const listing = await semiont.browse.files(CORPUS_DIR);
    let created = 0;
    let failed = 0;

    for (const entry of listing.entries) {
      if (entry.type !== 'file' || entry.tracked) continue;
      const format = FORMATS[extname(entry.name).toLowerCase()];
      if (!format) continue;

      try {
        const { resourceId } = await semiont.yield.resource({
          name: entry.name.replace(/\.(md|txt)$/, '').replace(/[_-]/g, ' '),
          file: readFileSync(entry.path),
          format,
          // Classify by your corpus's own layout: a directory, a filename pattern.
          entityTypes: ['Case', 'JudicialOpinion', 'StateCourt'],
          storageUri: `file://${entry.path}`,
        });
        created++;
        console.log(`  + ${entry.path} is ${resourceId}`);
      } catch (e) {
        failed++;
        console.warn(`  ! ${entry.path} failed:`, e);
      }
    }

    console.log(`Done. ${created} resources created, ${failed} failed.`);
  } finally {
    await session.dispose();
  }
}

ingest().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`browse.files(dir)` lists a directory of the knowledge base's working tree. A file that is already a resource has `tracked: true` and carries its `resourceId`.

## Guidance for the AI assistant

- **Declare the vocabulary first, and all of it.** Put every entity type the knowledge base's skills will use in one `KB_ENTITY_TYPES` list in the ingest script: the kinds of document, what detection looks for, what aggregates are stamped with.
- **Skip what is already a resource.** An upload does not check. `browse.files(dir)` says which files are tracked.
- **Classify precisely.** A contract is `['Contract']`, not `['Document']`. A judicial opinion is `['Case', 'JudicialOpinion', 'StateCourt']`, not `['Case']`. Later skills select documents by these types, and a vague type at ingest is a vague query later.
- **Keep the corpus in the knowledge base's repository.** `storageUri` is a path in its working tree, and the resource's content is the file at that path.
- **PDFs are first-class.** A PDF's text is extracted when it is ingested, and `mark.delegate` reads it. An encrypted or damaged PDF is still a resource, and a job over it completes with a `declined` result.
- **From the command line.** `semiont yield --upload <file>` makes one file under the knowledge base's root a resource, and `semiont frame --entity-type <name>` declares a type. Use them for a handful of files; write the script for a corpus.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. See [Error Handling](../../Usage.md#error-handling).
