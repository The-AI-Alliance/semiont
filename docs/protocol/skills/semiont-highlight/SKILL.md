---
name: semiont-highlight
description: Add highlighting annotations to a Semiont resource — mark key passages, important claims, or noteworthy content using AI-assisted or manual highlighting
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add highlighting annotations to a Semiont resource. Highlights mark passages worth a reader's attention — key claims, important evidence, surprising findings, or anything the user wants to surface.

This skill builds **Layer #2 (Annotations)** of the layered data model — `highlighting`-motivation annotations are first-class queryable spans that a downstream skill or UI can use to surface attention-worthy content.

## Two modes

**Delegate (AI-assisted)** — `mark.assist` with motivation `highlighting` runs the highlight pass autonomously across the document. Use this for bulk highlighting.

**Manual** — explicit `mark.annotation` with a `highlighting` body item. Use this for one-off corrections or additions.

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

`semiont.mark.assist(...)` returns a `StreamObservable<MarkAssistProgress>` — an Observable that's also awaitable. `await` resolves with the final progress payload (carrying the created count) when the job completes.

```typescript
const rId = resourceId('doc-123');

const progress = await semiont.mark.assist(rId, 'highlighting', {
  instructions: 'Focus on key claims and supporting evidence',
  density: 5,
});

console.log(`Created ${progress.progress?.createdCount ?? 0} highlights`);

semiont.dispose();
```

To observe intermediate progress (e.g. for a progress bar), subscribe directly instead of awaiting:

```typescript
semiont.mark.assist(rId, 'highlighting', { density: 5 }).subscribe({
  next: (p) => console.log(`progress ${p.progress?.percentage ?? 0}%`),
  complete: () => console.log('done'),
  error: (e) => console.error(e),
});
```

The namespace method handles SSE streaming, timeout (180 s without progress), and polling fallback internally. No separate state-unit construction or bus-emit is needed.

## Manual

```typescript
await semiont.mark.annotation({
  target: {
    source: rId,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'the exact text to highlight',
      prefix: 'words before ',
      suffix: ' words after',
    },
  },
  motivation: 'highlighting',
  body: [{
    type: 'TextualBody',
    value: 'Optional note about why this is highlighted',
    purpose: 'describing',
  }],
});
```

## Complete script skeleton

```typescript
import { SemiontClient, resourceId } from '@semiont/sdk';

async function highlight(resourceIdStr: string): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });
  const rId = resourceId(resourceIdStr);

  const progress = await semiont.mark.assist(rId, 'highlighting', {
    instructions: process.env.HIGHLIGHT_INSTRUCTIONS ??
      'Focus on key claims and supporting evidence',
    density: Number(process.env.HIGHLIGHT_DENSITY ?? 5),
  });

  console.log(`Created ${progress.progress?.createdCount ?? 0} highlights`);
  semiont.dispose();
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx highlight.ts <resourceId>');
  process.exit(1);
}
highlight(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Ask what to highlight** if the user hasn't said — key claims? risks? supporting evidence? quotes? The `instructions` parameter focuses the AI on what matters.
- **Density is the main tuning knob** (1-15, default mid-range). Start around 5 for selective highlighting. Go up to 10-15 for dense annotation of dense technical material. Go down to 1-3 for a light editorial pass.
- **Only `text/plain` and `text/markdown` resources are supported** for `mark.assist`. PDFs and images are not yet supported.
- **Check results** with `semiont.browse.annotations(rId)` — filter for `motivation === 'highlighting'`.
- **Manual mode is for corrections.** If the AI missed a specific passage, add it manually. Don't re-run delegate just to capture one passage.
- **Progress tracking** is available by subscribing to the Observable returned from `mark.assist`; each emission is a progress snapshot with `percentage` and `createdCount`.
- **CLI shortcut.** A thin CLI wrapper exists for one-off invocations — see [CLI cheatsheet](../CLI-CHEATSHEET.md). The SDK is primary; the CLI is a convenience for ad-hoc work.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated, with codes like `bus.timeout`). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
