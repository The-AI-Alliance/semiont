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

## Session setup (shared by all TypeScript examples below)

Scripts drive the API through a `SemiontSession`. Construct it once at the top of a script and reuse the same session for every verb call.

```typescript
import {
  SemiontSession,
  InMemorySessionStorage,
  setStoredSession,
  resourceId,
  type KnowledgeBase,
} from '@semiont/sdk';
import { lastValueFrom } from 'rxjs';

const apiUrl = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const kb: KnowledgeBase = {
  id: 'script',
  label: 'Script session',
  protocol: apiUrl.protocol.replace(':', '') as 'http' | 'https',
  host: apiUrl.hostname,
  port: Number(apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80)),
  email: process.env.SEMIONT_USER_EMAIL ?? 'script@local',
};

const storage = new InMemorySessionStorage();
setStoredSession(storage, kb.id, {
  access: process.env.SEMIONT_ACCESS_TOKEN ?? '',
  refresh: process.env.SEMIONT_REFRESH_TOKEN ?? '',
});

const session = new SemiontSession({
  kb,
  storage,
  // Scripts typically run inside one token lifetime. Extend with a real
  // re-auth call if the script runs past token expiry.
  refresh: async () => null,
});
await session.ready;
```

## TypeScript — delegate

`session.client.mark.assist(...)` returns an `Observable<MarkAssistProgress>` that emits progress updates and completes when the job finishes. `lastValueFrom` resolves with the final progress payload (carries the created count).

```typescript
const rId = resourceId('doc-123');

const progress = await lastValueFrom(
  session.client.mark.assist(rId, 'highlighting', {
    instructions: 'Focus on key claims and supporting evidence',
    density: 5,
  }),
);

console.log(`Created ${progress.progress?.createdCount ?? 0} highlights`);

await session.dispose();
```

To observe intermediate progress (e.g. for a progress bar), subscribe directly:

```typescript
session.client.mark.assist(rId, 'highlighting', { density: 5 }).subscribe({
  next: (p) => console.log(`progress ${p.progress?.percentage ?? 0}%`),
  complete: () => console.log('done'),
  error: (e) => console.error(e),
});
```

The namespace method handles SSE streaming, timeout (180 s without progress), and polling fallback internally. No separate VM construction or bus-emit is needed.

## TypeScript — manual

```typescript
await session.client.mark.annotation(rId, {
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
- **Check results** with `semiont browse resource <id> --annotations` or `session.client.browse.annotations(rId)` — filter for `motivation === 'highlighting'`.
- **Manual mode is for corrections.** If the AI missed a specific passage, add it manually. Don't re-run delegate just to capture one passage.
- **Progress tracking** is available by subscribing to the Observable returned from `mark.assist`; each emission is a progress snapshot with `percentage` and `createdCount`.
