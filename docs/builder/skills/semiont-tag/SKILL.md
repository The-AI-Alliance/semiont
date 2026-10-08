---
name: semiont-tag
description: Apply structural-analysis tag schemas to a Semiont resource — classify passages by their structural role using IRAC, IMRAD, Toulmin, or any KB-registered schema via mark.delegate with motivation tagging
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add tagging annotations to a Semiont resource. The `tagging` motivation classifies a passage by the role it plays in a document's structure, against a registered schema: IRAC (Issue, Rule, Application, Conclusion), IMRAD (Introduction, Methods, Results, Discussion), Toulmin (Claim, Evidence, Warrant, Counterargument, Rebuttal), or one the knowledge base defines.

This skill works in the annotation layer of [the layered data model](../README.md#the-layers). A tag is a span anyone can query, and its body names the schema and the category. An aggregating skill such as [`semiont-aggregate`](../semiont-aggregate/SKILL.md) walks tags to build a structural overview: every Rule paragraph in a corpus, every Methods section in a literature review.

## Tagging, or classifying with entity types

Two things look alike and are not the same.

- **Tagging against a schema (this skill).** The vocabulary is a registered schema whose categories come from a method of analysis and carry a description and examples. Use motivation `tagging` with `schemaId` and `categories`. The knowledge base registers the schema with `frame.addTagSchema`.
- **Classifying with entity types.** The vocabulary is a flat list the corpus declares for itself: theme labels, or role names such as `Plaintiff`, `Defendant` and `Counsel`. Use motivation `linking` with `entityTypes`, declared with `frame.addEntityTypes`. The annotation is a reference, and its body names the entity type. See [Classifying with entity types](#classifying-with-entity-types) below, and [`semiont-wiki`](../semiont-wiki/SKILL.md) for what references are for.

The test: does the vocabulary come from a published framework whose categories mean something on their own? IRAC does. Theme labels are discovered in one corpus. Role names are kinds of entity.

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs), so a session, not a bare client, is what keeps a script working past that. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-tag', label: 'Semiont',
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

## Tag against a schema

A tag schema belongs to the knowledge base that uses it. Write it as a `TagSchema` in the knowledge base's own source, register it, then run the job. A `tagging` job names its schema by id, and the stack refuses one whose schema is not registered (`Tag schema not registered: <id>`), so register first. Registering identical content again changes nothing, which makes it safe for every script to register the schemas it uses.

```typescript
import { resourceId, type TagSchema } from '@semiont/sdk';

const LEGAL_IRAC_SCHEMA: TagSchema = {
  id: 'legal-irac',
  name: 'Legal Analysis (IRAC)',
  description: 'Issue / Rule / Application / Conclusion framework for legal reasoning',
  domain: 'legal',
  tags: [
    { name: 'Issue',       description: 'The legal question to be resolved',   examples: ['What must the court decide?'] },
    { name: 'Rule',        description: 'The relevant law or legal principle', examples: ['What law applies?'] },
    { name: 'Application', description: 'How the rule applies to the facts',   examples: ['How does the law apply here?'] },
    { name: 'Conclusion',  description: 'The resolution',                      examples: ['What is the holding?'] },
  ],
};

await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

const rId = resourceId('opinion-citizens-united');

const done = await semiont.mark.delegate(rId, {
  motivation: 'tagging',
  schemaId: LEGAL_IRAC_SCHEMA.id,
  categories: LEGAL_IRAC_SCHEMA.tags.map((t) => t.name),
});

const { result } = done;
if (result && 'found' in result) {
  console.log(`Created ${result.persisted} of ${result.found} tags`, result.byCategory);
}

await session.dispose();
```

Awaiting `mark.delegate` resolves to the job's completion, the `job:complete` the job ended with. Its `result` is a `mark` job's, one of two: the counts of a job that did its work, or a decline, `{ declined: true, reason }`, for a resource whose text could not be read. The counts are the same for every motivation: `found` is what the model proposed, `persisted` is what was written, and `errors`, present only when there were some, is how many of the proposed could not be anchored in the text. A tagging job adds `byCategory`, the tags written for each category.

The worker reads the document once for each category, with that category's `description` and `examples` in its prompt, so the schema is the instruction. A category the schema does not have fails the job.

Each tag's body has two items:

- A `TextualBody` with `purpose: 'tagging'` whose value is the category.
- A `TextualBody` with `purpose: 'classifying'` whose value is the schema's id.

## Classifying with entity types

For a flat list that is not a schema, declare it as entity types and detect references to them. Declare first: a job that names an undeclared type is refused. Detection runs once for each type.

```typescript
import { entityType } from '@semiont/sdk';

const ROLES = ['Plaintiff', 'Defendant', 'Counsel'];
await semiont.frame.addEntityTypes(ROLES);

const done = await semiont.mark.delegate(rId, {
  motivation: 'linking',
  entityTypes: ROLES.map(entityType),
});

const { result } = done;
if (result && 'found' in result) {
  console.log(`Created ${result.persisted} of ${result.found} references`);
}
```

Each annotation has motivation `linking` and a body with one `TextualBody` whose `purpose` is `tagging` and whose value is the entity type. It gains a `SpecificResource` body when someone binds it to a resource.

## Manual

To write one tag by hand, give `mark.annotation` the same two-item body the worker writes:

```typescript
await semiont.mark.annotation({
  target: {
    source: rId,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'the paragraph that articulates the rule',
      prefix: 'preceding context ',
      suffix: ' subsequent context',
    },
  },
  motivation: 'tagging',
  body: [
    { type: 'TextualBody', purpose: 'tagging', value: 'Rule' },
    { type: 'TextualBody', purpose: 'classifying', value: 'legal-irac' },
  ],
});
```

And one entity-type classification:

```typescript
await semiont.mark.annotation({
  target: {
    source: rId,
    selector: { type: 'TextQuoteSelector', exact: 'Acme Holdings LLC' },
  },
  motivation: 'linking',
  body: [{ type: 'TextualBody', purpose: 'tagging', value: 'Defendant' }],
});
```

## Complete script

```typescript
import {
  SemiontSession, InMemorySessionStorage, httpKb, resourceId, type TagSchema,
} from '@semiont/sdk';

const LEGAL_IRAC_SCHEMA: TagSchema = {
  id: 'legal-irac',
  name: 'Legal Analysis (IRAC)',
  description: 'Issue / Rule / Application / Conclusion framework for legal reasoning',
  domain: 'legal',
  tags: [
    { name: 'Issue',       description: 'The legal question to be resolved',   examples: ['What must the court decide?'] },
    { name: 'Rule',        description: 'The relevant law or legal principle', examples: ['What law applies?'] },
    { name: 'Application', description: 'How the rule applies to the facts',   examples: ['How does the law apply here?'] },
    { name: 'Conclusion',  description: 'The resolution',                      examples: ['What is the holding?'] },
  ],
};

async function tagIRAC(resourceIdStr: string): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-tag', label: 'Semiont',
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
    await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

    const done = await semiont.mark.delegate(resourceId(resourceIdStr), {
      motivation: 'tagging',
      schemaId: LEGAL_IRAC_SCHEMA.id,
      categories: LEGAL_IRAC_SCHEMA.tags.map((t) => t.name),
    });

    const { result } = done;
    if (result && 'declined' in result) {
      console.log(`The resource's text could not be read: ${result.reason}`);
    } else if (result) {
      console.log(`Created ${result.persisted} of ${result.found} tags`, result.byCategory);
    }
  } finally {
    await session.dispose();
  }
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx tag-irac.ts <resourceId>');
  process.exit(1);
}
tagIRAC(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Decide which shape applies first.** A schema with categories from a method of analysis is `tagging` with `schemaId` and `categories`. A flat list the corpus defines is `linking` with `entityTypes`.
- **A schema lives with the knowledge base that uses it.** Write the `TagSchema` in the knowledge base's own source. Neither the SDK nor `@semiont/ontology` ships schemas.
- **Register before you tag.** `await semiont.frame.addTagSchema(schema)` before any `mark.delegate` with motivation `tagging`. `await semiont.browse.tagSchemas().fresh()` lists what a knowledge base has registered.
- **Themes the model discovers are entity types, not tags.** A `tagging` job needs its categories before it runs. When the values are only known afterwards, declare them with `frame.addEntityTypes` and classify with `linking`.
- **Neither job takes `instructions`.** A `tagging` job is instructed by the schema's descriptions and examples, and a `linking` job by the entity types it is given. A job given a param its motivation does not take is refused. To steer a tagging pass, edit the schema.
- **Tags feed aggregates.** [`semiont-aggregate`](../semiont-aggregate/SKILL.md) rolls tags up into a deliverable: a report of how later cases treated a precedent, a document's IRAC outline, a resource for each theme.
- **What `mark.delegate` can read.** A resource with text: Markdown, plain text, HTML, JSON, or a PDF. A resource with no text at all, such as an image, fails the job. A document whose text could not be read completes with a `declined` result and a reason code.
- **Check results** with `await semiont.browse.annotations(rId).fresh()`. The readers in `@semiont/sdk` tell the two apart and read each: a tag is `isTag`, with `getTagCategory` for its category and `getTagSchemaId` for its schema; an entity-type classification is `isReference`, with `getEntityTypes` for its types.
- **From the command line.** `semiont mark --delegate <resourceId> --motivation tagging --schema <id> --category <name>` runs the same job from the [launcher](../../../../apps/launcher/README.md#delegating-to-the-stack), and `semiont browse --tag-schemas` lists the schemas.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. `BusRequestError` (a bus request, with a code such as `bus.timeout`) and `JobFailedError` narrow it. See [Error Handling](../../Usage.md#error-handling).
