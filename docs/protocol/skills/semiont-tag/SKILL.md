---
name: semiont-tag
description: Apply structural-analysis tag schemas to a Semiont resource — classify passages by their structural role using IRAC, IMRAD, Toulmin, or any KB-registered schema via mark.assist with motivation tagging
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user apply **tagging annotations** to a Semiont resource. The `tagging` motivation is reserved for **structural-analysis classification** — applying a registered schema like IRAC (Issue / Rule / Application / Conclusion), IMRAD (Introduction / Methods / Results / Discussion), or Toulmin (Claim / Evidence / Warrant / Counterargument / Rebuttal) to identify the structural role each passage plays in a document.

This skill builds **Layer #2 (Annotations)** of the layered data model. Tagged annotations are queryable spans whose body carries the schema id (as a `classifying`-purpose `TextualBody`) plus the chosen category. Downstream aggregator skills (see [`semiont-aggregate`](../semiont-aggregate/SKILL.md)) walk these annotations to build structural overviews — *all the Rule paragraphs across the corpus*, *every Methods section in the literature review*.

## When to use this skill (vs. *vocabulary classification* via `linking`)

Two body-level shapes look similar but should not be confused:

- **Structural-analysis tagging (this skill).** The vocabulary is a *registered schema* — fixed, broadly-applicable, with categories that carry methodology-bound semantics (descriptions, examples). The categories are not user-defined per-corpus; they're defined by a research-methods framework. Use motivation `tagging`, pass `schemaId` and `categories`. The KB owns the schema definitions and registers them at runtime via `frame.addTagSchema(...)`.
- **Vocabulary classification.** The "tag" is a flat enum the corpus declares for itself — theme labels (open-vocabulary), role tags (`Plaintiff`, `Defendant`, `Counsel`). Use motivation `linking` with `entityTypes`, declared via `frame.addEntityTypes` per KB. The annotation is technically a linking annotation; the body's tagging-purpose `TextualBody` carries the chosen value. See [`semiont-wiki`](../semiont-wiki/SKILL.md) for the linking-annotation pattern; the *Vocabulary classification* example below shows how to use it for flat enums.

The decision test: **does the vocabulary correspond to a published research-methods framework with category-level semantics?** IRAC yes (it's been the standard frame for legal analysis for decades). Theme labels no (they're discovered per corpus). Role tags no (they're entity-type subtypes).

## Prerequisite (structural-analysis tagging only): the schema must be registered

Tag schemas are runtime-registered per KB. The dispatcher resolves `schemaId` → full `TagSchema` against the KB's `__system__` projection at job-creation time; if the schema isn't registered, `mark.assist(..., 'tagging', { schemaId, ... })` rejects synchronously with `Tag schema not registered: <schemaId>`. You can:

- Register the schema in this script via `await semiont.frame.addTagSchema(SCHEMA)` before calling `mark.assist`. Idempotent — re-runs with identical content are silent at the projection layer. This is the recommended pattern: each skill self-registers the schema(s) it uses.
- Rely on a prior `register-tag-schemas` skill run to have populated the KB's projection. The semiont-* demo KBs each ship a `skills/register-tag-schemas/` for one-time bootstrap.
- For vocabulary classifications that don't deserve a registered schema, use the linking shape (see below) instead of `tagging`.

## Client setup

```typescript
import { SemiontClient, type TagSchema, resourceId } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
```

For long-running scripts that may span token expiry, use `SemiontSession.signInHttp(...)` instead.

## Structural-analysis tagging (motivation `tagging`)

Define the schema in your KB (typically in `src/tag-schemas.ts`), register it at startup, then call `mark.assist`:

```typescript
import { LEGAL_IRAC_SCHEMA } from '../../src/tag-schemas.js';

// Register the schema (idempotent — silent on identical re-registration).
await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

const rId = resourceId('opinion-citizens-united');

// Apply the IRAC schema to a judicial opinion
const progress = await semiont.mark.assist(rId, 'tagging', {
  schemaId: LEGAL_IRAC_SCHEMA.id,
  categories: LEGAL_IRAC_SCHEMA.tags.map((t) => t.name),
});

console.log(`Created ${progress.progress?.createdCount ?? 0} IRAC tags`);

semiont.dispose();
```

The dispatcher resolves the `schemaId` against the KB's projection, embeds the full `TagSchema` in the worker's job params, and validates each `categories` entry against the schema's `tags`. Each resulting annotation gets a body containing:

- A `TextualBody` with `purpose: 'classifying'` and `value: schemaId` — identifies which schema applied.
- A `TextualBody` with `purpose: 'tagging'` and `value: <categoryName>` — the chosen category for this span.

Downstream skills can query for *every IRAC-Rule annotation across the corpus* via `browse.annotations` filtered on motivation + body shape.

## Defining a new tag schema

Author the schema directly in your KB's `src/tag-schemas.ts`:

```typescript
import type { TagSchema } from '@semiont/sdk';

export const LEGAL_CITATION_TREATMENT_SCHEMA: TagSchema = {
  id: 'legal-citation-treatment',
  name: 'Citation Treatment',
  description: 'Citator-style classification of how a citing case treats the cited case',
  domain: 'legal',
  tags: [
    {
      name: 'positive',
      description: 'The citing case relies on, follows, applies, or extends the cited case',
      examples: ['The court relied on Roe v. Wade in reaching its conclusion.'],
    },
    // ... more categories
  ],
};
```

Register at runtime via `frame.addTagSchema(...)` from any script that uses it. The schema's per-category `description` and `examples` get fed into the worker's prompt automatically — no separate `instructions` block required.

## Vocabulary classification (motivation `linking`)

For flat enums that aren't a structural-analysis schema — theme labels, role tags — use motivation `linking` with `entityTypes` listing the vocabulary. Declare the vocabulary via `frame.addEntityTypes` so it's queryable as part of the published entity-type set.

```typescript
// Declare the vocabulary as part of the KB's entity-type set.
const ROLES = ['Plaintiff', 'Defendant', 'Counsel'];
await semiont.frame.addEntityTypes(ROLES);

// Run the classification pass — motivation `linking`, entityTypes carrying the vocabulary.
const progress = await semiont.mark.assist(rId, 'linking', {
  entityTypes: ROLES.map(entityType),
  instructions: `Tag each named party with their role in the action.`,
});
```

Each resulting annotation has motivation `linking` and a body containing a `TextualBody` with `purpose: 'tagging'` and the chosen value. Downstream skills query for *every annotation tagged 'Defendant'* by walking linking annotations and inspecting the entity-type tagging body.

## Manual

For one-off targeted classification, use `mark.annotation` directly. For genuine `tagging` motivation, the body needs the schema-id `classifying` body plus the category:

```typescript
// Manual structural-analysis tag (IRAC):
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
    { type: 'TextualBody', purpose: 'classifying', value: 'legal-irac' },
    { type: 'TextualBody', purpose: 'tagging', value: 'Rule' },
  ],
});

// Manual vocabulary-classification tag (role):
await semiont.mark.annotation({
  target: { source: rId, selector: { type: 'TextQuoteSelector', exact: '...' } },
  motivation: 'linking',
  body: [
    { type: 'TextualBody', purpose: 'tagging', value: 'Defendant' },
  ],
});
```

## Complete script skeleton (structural-analysis IRAC)

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';
import { LEGAL_IRAC_SCHEMA } from '../../src/tag-schemas.js';

async function tagIRAC(resourceIdStr: string): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });

  // Self-register the schema. Idempotent.
  await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

  const rId = resourceId(resourceIdStr);

  const progress = await semiont.mark.assist(rId, 'tagging', {
    schemaId: LEGAL_IRAC_SCHEMA.id,
    categories: LEGAL_IRAC_SCHEMA.tags.map((t) => t.name),
  });

  console.log(`Created ${progress.progress?.createdCount ?? 0} IRAC tags`);
  semiont.dispose();
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

- **First decide which shape applies.** Before writing the skill, ask: *is the vocabulary a structural-analysis schema (IRAC / IMRAD / Toulmin / similar) with methodology-bound category semantics, or is it a flat per-corpus enum?* Only the first uses motivation `tagging` with `schemaId` + `categories`. The second uses motivation `linking` with `entityTypes`.
- **Schemas live with the KB that uses them.** Author the `TagSchema` literal in the KB's `src/tag-schemas.ts`. Don't try to add it to the SDK or to `@semiont/ontology` — neither owns schema data anymore.
- **Self-register at the top of the skill.** `await semiont.frame.addTagSchema(THE_SCHEMA)` before any `mark.assist(..., 'tagging', ...)` call. Idempotent — re-runs are silent if the schema content is identical.
- **The dispatcher rejects unknown schemaIds synchronously.** Calling `mark.assist(..., 'tagging', { schemaId: 'foo', categories: [...] })` against a KB that hasn't registered `'foo'` throws `Tag schema not registered: foo` at job-creation time. Verify your skill's schema-registration call runs before `mark.assist`.
- **For vocabulary classifications, use `linking` + `entityTypes`.** Theme labels, role-tag enums, period themes, controlled-vocabulary anything that isn't methodology-bound. Declare the vocabulary via `frame.addEntityTypes`. The annotation is a linking annotation; its body's `tagging`-purpose `TextualBody` carries the value.
- **Open-vocabulary themes are linking, not tagging.** When the model picks tag values itself (e.g., recurring themes from a literary corpus), the schema is unknown until after the run. This is the linking shape with `entityTypes` declared after the run via `frame.addEntityTypes` — *not* genuine `tagging`, which would require the categories upfront.
- **Resulting annotation body shape.**
  - Genuine tagging: `[{ type: 'TextualBody', purpose: 'classifying', value: '<schemaId>' }, { type: 'TextualBody', purpose: 'tagging', value: '<category>' }]`. The classifying body identifies which schema; the tagging body carries the category.
  - Vocabulary linking: `[{ type: 'TextualBody', purpose: 'tagging', value: '<vocab-value>' }]` (and possibly a `SpecificResource` body if the linking annotation also resolves to a canonical node).
- **Tags feed `semiont-aggregate`.** Whether tagging or vocabulary-linking, a downstream aggregator walks these annotations and rolls them up into deliverables (a SubsequentTreatment report, a per-document IRAC structural overview, a Theme resource per distinct theme value).
- **Only `text/plain` and `text/markdown` resources are supported** for `mark.assist`. PDFs and images are not yet supported.
- **Check results** with `semiont.browse.annotations(rId)` — for tagging filter on `motivation === 'tagging'` and inspect the `classifying` body; for linking-as-tagging filter on `motivation === 'linking'` and the `tagging`-purpose body value. To list which schemas a KB has registered, use `await semiont.browse.tagSchemas()` (cached per session, refreshes on `frame:tag-schema-added`).
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
