---
name: semiont-highlight
description: Add highlighting annotations to a Semiont resource — mark key passages, important claims, or noteworthy content using AI-assisted or manual highlighting
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add highlighting annotations to a Semiont resource. Highlights mark passages worth a reader's attention — key claims, important evidence, surprising findings, or anything the user wants to surface.

## Two modes

**Delegate (AI-assisted)** — the API generates highlights autonomously from the document content. Use this for bulk highlighting.

**Manual** — the user specifies the exact text to highlight. Use this for one-off corrections or additions.

## CLI — delegate

```bash
semiont mark --resource <id> --delegate --motivation highlighting \
  [--instructions "<focus guidance>"] \
  [--density <1-15>]
```

- `--density` controls highlights per ~2000 words (default mid-range; lower = more selective, higher = more comprehensive)
- `--instructions` up to 500 chars of free-text guidance, e.g. `"focus on risk factors and mitigation strategies"`
- Find the resource ID: `semiont browse resources --search "<name>"`

## Client setup (shared by all TypeScript examples below)

Scripts construct a `SemiontClient` over `HttpTransport` directly. Construct it once at the top of a script and reuse the same client for every verb call. For long-running scripts that may span token expiry, use `SemiontSession` from `@semiont/sdk` instead — it owns refresh, validation, and storage; the lighter pattern below is right for one-shot work.

```typescript
import {
  SemiontClient,
  HttpTransport,
  HttpContentTransport,
} from '@semiont/sdk';
import {
  accessToken,
  baseUrl,
  resourceId,
  type AccessToken,
} from '@semiont/core';
import { BehaviorSubject, lastValueFrom } from 'rxjs';

const token$ = new BehaviorSubject<AccessToken | null>(
  accessToken(process.env.SEMIONT_ACCESS_TOKEN ?? ''),
);
const transport = new HttpTransport({
  baseUrl: baseUrl(process.env.SEMIONT_API_URL ?? 'http://localhost:4000'),
  token$,
});
const semiont = new SemiontClient(transport, new HttpContentTransport(transport));
```

## TypeScript — delegate

`semiont.mark.assist(...)` returns an `Observable<MarkAssistProgress>` that emits progress updates and completes when the job finishes. `lastValueFrom` resolves with the final progress payload (carries the created count).

```typescript
const rId = resourceId('doc-123');

const progress = await lastValueFrom(
  semiont.mark.assist(rId, 'highlighting', {
    instructions: 'Focus on key claims and supporting evidence',
    density: 5,
  }),
);

console.log(`Created ${progress.progress?.createdCount ?? 0} highlights`);

semiont.dispose();
```

To observe intermediate progress (e.g. for a progress bar), subscribe directly:

```typescript
semiont.mark.assist(rId, 'highlighting', { density: 5 }).subscribe({
  next: (p) => console.log(`progress ${p.progress?.percentage ?? 0}%`),
  complete: () => console.log('done'),
  error: (e) => console.error(e),
});
```

The namespace method handles SSE streaming, timeout (180 s without progress), and polling fallback internally. No separate VM construction or bus-emit is needed.

## TypeScript — manual

```typescript
await semiont.mark.annotation(rId, {
  motivation: 'highlighting',
  target: {
    source: rId,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'the exact text to highlight',
      prefix: 'words before ',
      suffix: ' words after',
    },
  },
  body: [{
    type: 'TextualBody',
    value: 'Optional note about why this is highlighted',
    purpose: 'describing',
  }],
});
```

## Guidance for the AI assistant

- **Ask what to highlight** if the user hasn't said — key claims? risks? supporting evidence? quotes? The `--instructions` flag focuses the AI on what matters.
- **Density is the main tuning knob.** Start around 5 for selective highlighting. Go up to 10-15 for dense annotation of dense technical material. Go down to 1-3 for a light editorial pass.
- **Only `text/plain` and `text/markdown` resources are supported.** PDFs and images are not yet supported.
- **Check results** with `semiont browse resource <id> --annotations` or `semiont.browse.annotations(rId)` — filter for `motivation === 'highlighting'`.
- **Manual mode is for corrections.** If the AI missed a specific passage, add it manually. Don't re-run delegate just to capture one passage.
- **Progress tracking** is available by subscribing to the Observable returned from `mark.assist`; each emission is a progress snapshot with `percentage` and `createdCount`.
