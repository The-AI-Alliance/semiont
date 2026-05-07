---
name: semiont-comment
description: Add commenting annotations to a Semiont resource — suggest edits, ask questions of the author, or point things out to readers using AI-assisted or manual commenting
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add commenting annotations to a Semiont resource. Comments are conversational annotations attached to specific passages — editorial suggestions, questions for the author, clarifications for readers, or observations that don't fit assessment or highlighting.

This skill builds **Layer #2 (Annotations)** of the layered data model — `commenting`-motivation annotations are first-class queryable spans whose body is the comment text.

## Two modes

**Delegate (AI-assisted)** — `mark.assist` with motivation `commenting` runs the editorial pass autonomously across the document. Use this for systematic editorial review.

**Manual** — explicit `mark.annotation` with a `commenting` body item. Use this for a specific comment on a specific passage.

## Client setup

`SemiontClient.signInHttp(...)` is the credentials-first one-line construction for one-shot scripts. It calls `auth.password(email, password)` and returns a wired-up client with the access token populated. Construct once at the top of a script and reuse the same client for every verb call.

For long-running scripts that may span token expiry, use `SemiontSession.signInHttp(...)` instead — it owns refresh, validation, and storage; the lighter pattern below is right for one-shot work. If you already have an access token (cached from a prior auth, or supplied by an embedding host), use `SemiontClient.fromHttp({ baseUrl, token })` to skip the auth round-trip.

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
```

## Delegate (AI-assisted)

`semiont.mark.assist(...)` returns a `StreamObservable<MarkAssistProgress>` — an Observable that's also awaitable. `await` resolves with the final progress payload once the job completes.

```typescript
const rId = resourceId('doc-123');

const progress = await semiont.mark.assist(rId, 'commenting', {
  tone: 'conversational',
  instructions: 'Suggest edits to improve clarity and ask questions where the reasoning is unclear',
  density: 5,
});

console.log(`Created ${progress.progress?.createdCount ?? 0} comments`);

semiont.dispose();
```

The namespace method handles SSE streaming, timeout (180 s without progress), and polling fallback internally.

To observe intermediate progress (e.g. for a progress bar), subscribe directly instead of awaiting:

```typescript
semiont.mark.assist(rId, 'commenting', { density: 5 }).subscribe({
  next: (p) => console.log(`progress ${p.progress?.percentage ?? 0}%`),
  complete: () => console.log('done'),
  error: (e) => console.error(e),
});
```

## Manual

```typescript
await semiont.mark.annotation({
  target: {
    source: rId,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'the passage being commented on',
      prefix: 'words before ',
      suffix: ' words after',
    },
  },
  motivation: 'commenting',
  body: [{
    type: 'TextualBody',
    value: 'Consider reordering this paragraph — the conclusion appears before the supporting evidence.',
    purpose: 'commenting',
  }],
});
```

## Complete script skeleton

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

async function comment(resourceIdStr: string): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });
  const rId = resourceId(resourceIdStr);

  const progress = await semiont.mark.assist(rId, 'commenting', {
    tone: process.env.COMMENT_TONE ?? 'conversational',
    instructions: process.env.COMMENT_INSTRUCTIONS ??
      'Suggest edits to improve clarity and ask questions where the reasoning is unclear',
    density: Number(process.env.COMMENT_DENSITY ?? 5),
  });

  console.log(`Created ${progress.progress?.createdCount ?? 0} comments`);
  semiont.dispose();
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx comment.ts <resourceId>');
  process.exit(1);
}
comment(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Ask who the comments are for.** Comments can be addressed to the author ("you should clarify..."), to readers ("note that..."), or to collaborators ("this contradicts section 3"). The `instructions` parameter sets the audience and purpose.
- **Tone selection by use case** (default: `conversational`):
  - `scholarly` — peer review, academic manuscripts, formal reports
  - `explanatory` — onboarding docs, user-facing content, tutorials
  - `conversational` — collaborative drafts, editorial passes, general documents
  - `technical` — API docs, specs, engineering documents
- **Density for comments** (2-12). Start at 4-6 for a moderate editorial pass. High density (8-12) is appropriate for detailed line editing of short documents.
- **Only `text/plain` and `text/markdown` resources are supported** for `mark.assist`. PDFs and images are not yet supported.
- **Distinguish from assessments and tags.** Comments are for dialogue and editorial improvement. Assessments flag objective risks or errors. Tags classify against a controlled vocabulary. Use `commenting` when the goal is to help the author revise or help readers understand; use `assessing` when the goal is to flag a problem; use `tagging` when the goal is to apply a controlled-vocabulary classification.
- **Manual mode is for specific targeted feedback.** When the user knows exactly what they want to say about a specific passage, manual mode is faster and more precise than running delegate.
- **Check results** with `semiont.browse.annotations(rId)` — filter for `motivation === 'commenting'`.
- **CLI shortcut.** A thin CLI wrapper exists for one-off invocations — see [CLI cheatsheet](../CLI-CHEATSHEET.md). The SDK is primary; the CLI is a convenience for ad-hoc work.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated, with codes like `bus.timeout`). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
