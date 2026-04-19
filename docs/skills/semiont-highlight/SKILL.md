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

## TypeScript — delegate

Uses `createMarkVM` from `@semiont/api-client` to manage the assist lifecycle, including timeout and error handling.

```typescript
import { SemiontApiClient, createMarkVM, resourceId } from '@semiont/api-client';
import { EventBus, accessToken, type AccessToken } from '@semiont/core';
import { firstValueFrom, BehaviorSubject } from 'rxjs';
import { filter } from 'rxjs/operators';

const eventBus = new EventBus();

const client = new SemiontApiClient({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  eventBus,
  token$: new BehaviorSubject<AccessToken | null>(
    process.env.SEMIONT_ACCESS_TOKEN ? accessToken(process.env.SEMIONT_ACCESS_TOKEN) : null
  ),
});

const rId = resourceId('doc-123');
const markVM = createMarkVM(client, eventBus, rId);

eventBus.get('mark:assist-request').next({
  motivation: 'highlighting',
  options: {
    instructions: 'Focus on key claims and supporting evidence',
    density: 5,
  },
});

const finished = await firstValueFrom(
  eventBus.get('mark:assist-finished').pipe(
    filter((e) => e.motivation === 'highlighting'),
  ),
);

console.log(`Created ${finished.progress?.createdCount ?? 0} highlights`);

markVM.dispose();
eventBus.destroy();
```

The MarkVM handles:
- Calling `client.mark.assist()` when `mark:assist-request` is emitted
- Tracking progress via `markVM.progress$`
- Timeout (180s without progress) that emits `mark:assist-failed`
- Clearing state on completion or failure

## TypeScript — manual

```typescript
await client.mark.annotation(rId, {
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
- **Check results** with `semiont browse resource <id> --annotations` or `client.browse.annotations(rId)` — filter for `motivation === 'highlighting'`.
- **Manual mode is for corrections.** If the AI missed a specific passage, add it manually. Don't re-run delegate just to capture one passage.
- **The MarkVM's `progress$` Observable** emits `{ status, percentage, createdCount }` during assist for progress tracking.
