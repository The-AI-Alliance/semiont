---
name: semiont-tag
description: Apply structural-analysis tag schemas to a Semiont resource — classify passages by their structural role using IRAC, IMRAD, Toulmin, or other registered schemas via mark.assist with motivation tagging
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user apply **tagging annotations** to a Semiont resource. The `tagging` motivation is reserved for **structural-analysis classification** — applying a registered schema like IRAC (Issue / Rule / Application / Conclusion), IMRAD (Introduction / Methods / Results / Discussion), or Toulmin (Claim / Evidence / Warrant / Counterargument / Rebuttal) to identify the structural role each passage plays in a document.

This skill builds **Layer #2 (Annotations)** of the layered data model. Tagged annotations are queryable spans whose body carries the schema id (as a `classifying`-purpose `TextualBody`) plus the chosen category. Downstream aggregator skills (see [`semiont-aggregate`](../semiont-aggregate/SKILL.md)) walk these annotations to build structural overviews — *all the Rule paragraphs across the corpus*, *every Methods section in the literature review*.

## When to use this skill (vs. *vocabulary classification* via `linking`)

Two body-level shapes look similar but should not be confused:

- **Structural-analysis tagging (this skill).** The vocabulary is a *registered schema* — fixed, broadly-applicable, with categories that carry methodology-bound semantics (descriptions, examples). The categories are not user-defined per-corpus; they're defined by a research-methods framework. Use motivation `tagging`, pass `schemaId` and `categories`. Currently registered schemas: `legal-irac`, `scientific-imrad`, `argument-toulmin`.
- **Vocabulary classification.** The "tag" is a flat enum the corpus declares for itself — citation treatment values (`positive`, `negative`, `distinguished`, `criticized`, `overruled`, `neutral`), theme labels (open-vocabulary), role tags (`Plaintiff`, `Defendant`, `Counsel`). Use motivation `linking` with `entityTypes`, declared via `frame.addEntityTypes` per KB. The annotation is technically a linking annotation; the body's tagging-purpose `TextualBody` carries the chosen value. See [`semiont-wiki`](../semiont-wiki/SKILL.md) for the linking-annotation pattern; the *Vocabulary classification* example below shows how to use it for flat enums.

The decision test: **does the vocabulary correspond to a published research-methods framework with category-level semantics?** IRAC yes (it's been the standard frame for legal analysis for decades). Citation treatment no (it's a flat enum we apply per case). Theme labels no (they're discovered per corpus). Role tags no (they're entity-type subtypes).

## Prerequisite (structural-analysis tagging only): the schema must be registered

The SDK enforces that `schemaId` and `categories` are valid against the registry in `packages/ontology/src/tag-schemas.ts`. If you call `mark.assist(rId, 'tagging', { schemaId: 'foo', categories: [...] })` with an unregistered schema, the worker throws `Invalid tag schema: foo`. You can:

- Use one of the registered schemas (`legal-irac`, `scientific-imrad`, `argument-toulmin`).
- Submit a PR adding a new schema to `packages/ontology/src/tag-schemas.ts` for genuinely shared structural-analysis frameworks.
- For vocabulary classifications that don't deserve a registered schema, use the linking shape (see below) instead of `tagging`.

There is currently no `frame.addTagSchema(...)` for skill-local tag schemas. If you need one, that's a real architectural gap worth raising upstream — the SDK should grow runtime extensibility for tag schemas the same way `frame.addEntityType` provides it for entity types.

## Client setup

```typescript
import { SemiontClient, entityType, resourceId } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
```

For long-running scripts that may span token expiry, use `SemiontSession.signInHttp(...)` instead.

## Structural-analysis tagging (motivation `tagging`)

Pass the `schemaId` of a registered schema plus the `categories` (a subset, or all of them) you want the model to apply.

```typescript
const rId = resourceId('opinion-citizens-united');

// Apply the IRAC schema to a judicial opinion
const progress = await semiont.mark.assist(rId, 'tagging', {
  schemaId: 'legal-irac',
  categories: ['Issue', 'Rule', 'Application', 'Conclusion'],
});

console.log(`Created ${progress.progress?.createdCount ?? 0} IRAC tags`);

semiont.dispose();
```

The worker validates `schemaId` against the registry and validates each `categories` entry against `getSchemaCategory(schemaId, name)`. Each resulting annotation gets a body containing:

- A `TextualBody` with `purpose: 'classifying'` and `value: schemaId` — identifies which schema applied.
- A `TextualBody` with `purpose: 'tagging'` and `value: <categoryName>` — the chosen category for this span.

Downstream skills can query for *every IRAC-Rule annotation across the corpus* via `browse.annotations` filtered on motivation + body shape.

## Vocabulary classification (motivation `linking`)

For flat enums that aren't a registered schema — citation treatment, theme labels, role tags — use motivation `linking` with `entityTypes` listing the vocabulary. Declare the vocabulary via `frame.addEntityTypes` so it's queryable as part of the published entity-type set.

```typescript
// Declare the treatment vocabulary as part of the KB's entity-type set.
// Normally done at ingest by `semiont-ingest`; shown here for clarity.
const TREATMENT = ['positive', 'negative', 'distinguished', 'criticized', 'overruled', 'neutral'];
await semiont.frame.addEntityTypes(TREATMENT);

// Run the classification pass — motivation `linking`, entityTypes carrying the vocabulary.
const progress = await semiont.mark.assist(rId, 'linking', {
  entityTypes: TREATMENT.map(entityType),
  instructions: `
For each citation of the target case in this opinion, classify how the citing court treats it.
Tag the span where the treatment is established. Use exactly one entity-type tag per span:
  - positive       (relies on / follows / extends the cited case)
  - negative       (rejects or disagrees with — without overruling)
  - distinguished  (acknowledges but distinguishes on facts)
  - criticized     (criticizes the cited case's reasoning)
  - overruled      (overrules the cited case in part or whole)
  - neutral        (string-cite or background mention)
`.trim(),
});

console.log(`Created ${progress.progress?.createdCount ?? 0} treatment tags`);
```

Each resulting annotation has motivation `linking` and a body containing a `TextualBody` with `purpose: 'tagging'` and the chosen value. Downstream skills query for *every annotation tagged 'overruled' that resolves to target case X* by walking linking annotations and inspecting both the entity-type tagging body and the SpecificResource body items.

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

// Manual vocabulary-classification tag (treatment):
await semiont.mark.annotation({
  target: { source: rId, selector: { type: 'TextQuoteSelector', exact: '...' } },
  motivation: 'linking',
  body: [
    { type: 'TextualBody', purpose: 'tagging', value: 'distinguished' },
  ],
});
```

## Complete script skeleton (structural-analysis IRAC)

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

async function tagIRAC(resourceIdStr: string): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });
  const rId = resourceId(resourceIdStr);

  const progress = await semiont.mark.assist(rId, 'tagging', {
    schemaId: 'legal-irac',
    categories: ['Issue', 'Rule', 'Application', 'Conclusion'],
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

- **First decide which shape applies.** Before writing the skill, ask: *is the vocabulary a registered structural-analysis schema (IRAC / IMRAD / Toulmin), or is it a flat per-corpus enum?* Only the first uses motivation `tagging` with `schemaId` + `categories`. The second uses motivation `linking` with `entityTypes`.
- **The SDK enforces schemaId validity.** Calling `mark.assist(..., 'tagging', { schemaId: 'foo', categories: [...] })` with an unregistered schemaId throws `Invalid tag schema: foo` from the worker. Verify the schemaId exists in `packages/ontology/src/tag-schemas.ts` (or its `getTagSchema(id)` helper at runtime).
- **Currently registered schemas:** `legal-irac`, `scientific-imrad`, `argument-toulmin`. Pre-existing structural-analysis frameworks. To add one, PR `packages/ontology/src/tag-schemas.ts`.
- **For vocabulary classifications, use `linking` + `entityTypes`.** Citation treatment, theme labels, role-tag enums, period themes, controlled-vocabulary anything that isn't methodology-bound. Declare the vocabulary via `frame.addEntityTypes`. The annotation is a linking annotation; its body's `tagging`-purpose `TextualBody` carries the value.
- **Open-vocabulary themes are linking, not tagging.** When the model picks tag values itself (e.g., recurring themes from a literary corpus), the schema is unknown until after the run. This is the linking shape with `entityTypes` declared after the run via `frame.addEntityTypes` — *not* genuine `tagging`, which would require the categories upfront.
- **Resulting annotation body shape.**
  - Genuine tagging: `[{ type: 'TextualBody', purpose: 'classifying', value: '<schemaId>' }, { type: 'TextualBody', purpose: 'tagging', value: '<category>' }]`. The classifying body identifies which schema; the tagging body carries the category.
  - Vocabulary linking: `[{ type: 'TextualBody', purpose: 'tagging', value: '<vocab-value>' }]` (and possibly a `SpecificResource` body if the linking annotation also resolves to a canonical node).
- **Tags feed `semiont-aggregate`.** Whether tagging or vocabulary-linking, a downstream aggregator walks these annotations and rolls them up into deliverables (a SubsequentTreatment report, a per-document IRAC structural overview, a Theme resource per distinct theme value).
- **Only `text/plain` and `text/markdown` resources are supported** for `mark.assist`. PDFs and images are not yet supported.
- **Check results** with `semiont.browse.annotations(rId)` — for tagging filter on `motivation === 'tagging'` and inspect the `classifying` body; for linking-as-tagging filter on `motivation === 'linking'` and the `tagging`-purpose body value.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
