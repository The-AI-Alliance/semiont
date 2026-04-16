---
name: semiont-comment
description: Add commenting annotations to a Semiont resource — suggest edits, ask questions of the author, or point things out to readers using AI-assisted or manual commenting
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add commenting annotations to a Semiont resource. Comments are conversational annotations attached to specific passages — editorial suggestions, questions for the author, clarifications for readers, or observations that don't fit assessment or highlighting.

## Two modes

**Delegate (AI-assisted)** — the API generates comments autonomously from the document content. Use this for systematic editorial review.

**Manual** — the user writes a specific comment on a specific passage. Use this for targeted feedback.

## CLI — delegate

```bash
semiont mark --resource <id> --delegate --motivation commenting \
  [--tone scholarly|explanatory|conversational|technical] \
  [--instructions "<what kind of comments to add>"] \
  [--density <2-12>]
```

- `--tone` shapes the voice and audience of comments (default: `conversational`):
  - `scholarly` — formal academic register, citations, precision
  - `explanatory` — clarifies for readers unfamiliar with the domain
  - `conversational` — informal, direct, editorial
  - `technical` — precise, targeted at practitioners
- `--instructions` guides the type of comments, e.g. `"suggest edits to align with the executive summary"` or `"ask questions a first-time reader would have"` or `"point out where more supporting evidence is needed"`
- Find the resource ID: `semiont browse resources --search "<name>"`

## TypeScript — delegate

Uses `createMarkVM` from `@semiont/api-client` to manage the assist lifecycle, including timeout and error handling.

```typescript
import { SemiontApiClient, createMarkVM, resourceId } from '@semiont/api-client';
import { EventBus } from '@semiont/core';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';

const client = new SemiontApiClient({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  accessToken: process.env.SEMIONT_ACCESS_TOKEN,
});

const rId = resourceId('doc-123');
const eventBus = new EventBus();
const markVM = createMarkVM(client, eventBus, rId);

eventBus.get('mark:assist-request').next({
  motivation: 'commenting',
  options: {
    tone: 'conversational',
    instructions: 'Suggest edits to improve clarity and ask questions where the reasoning is unclear',
    density: 5,
  },
});

const finished = await firstValueFrom(
  eventBus.get('mark:assist-finished').pipe(
    filter((e) => e.motivation === 'commenting'),
  ),
);

console.log(`Created ${finished.progress?.createdCount ?? 0} comments`);

markVM.dispose();
eventBus.destroy();
```

## TypeScript — manual

```typescript
await client.mark.annotation(rId, {
  motivation: 'commenting',
  target: {
    source: rId,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'the passage being commented on',
      prefix: 'words before ',
      suffix: ' words after',
    },
  },
  body: [{
    type: 'TextualBody',
    value: 'Consider reordering this paragraph — the conclusion appears before the supporting evidence.',
    purpose: 'commenting',
  }],
});
```

## Guidance for the AI assistant

- **Ask who the comments are for.** Comments can be addressed to the author ("you should clarify..."), to readers ("note that..."), or to collaborators ("this contradicts section 3"). The `--instructions` flag sets the audience and purpose.
- **Tone selection by use case:**
  - `scholarly` — peer review, academic manuscripts, formal reports
  - `explanatory` — onboarding docs, user-facing content, tutorials
  - `conversational` — collaborative drafts, editorial passes, general documents
  - `technical` — API docs, specs, engineering documents
- **Density for comments** (2-12). Start at 4-6 for a moderate editorial pass. High density (8-12) is appropriate for detailed line editing of short documents.
- **Only `text/plain` and `text/markdown` resources are supported.** PDFs and images are not yet supported.
- **Distinguish from assessments.** Comments are for dialogue and editorial improvement. Assessments are for flagging objective risks or errors. Use `commenting` when the goal is to help the author revise or help readers understand; use `assessing` when the goal is to flag a problem.
- **Manual mode is for specific targeted feedback.** When the user knows exactly what they want to say about a specific passage, manual mode is faster and more precise than running delegate.
- **Check results** with `client.browse.annotations(rId)` — filter for `motivation === 'commenting'`.
