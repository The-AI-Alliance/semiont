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

```typescript
import { SemiontApiClient, resourceId } from '@semiont/api-client';
import { EventBus } from '@semiont/core';

const client = new SemiontApiClient({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  accessToken: process.env.SEMIONT_ACCESS_TOKEN,
});

const rId = resourceId('doc-123');
const eventBus = new EventBus();

const count = await new Promise<number>((resolve, reject) => {
  eventBus.get('mark:assist-finished').subscribe(result => {
    resolve(result.progress?.createdCount ?? 0);
  });
  eventBus.get('mark:assist-failed').subscribe(({ error }) => reject(error));

  client.sse.markHighlights(rId, {
    instructions: 'Focus on key claims and supporting evidence',
    density: 5,
  }, {
    auth: client.accessToken,
    eventBus,
  });
});

eventBus.destroy();
console.log(`Created ${count} highlights`);
```

## TypeScript — manual

```typescript
await client.markAnnotation(rId, {
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
}, { auth: client.accessToken });
```

## Guidance for the AI assistant

- **Ask what to highlight** if the user hasn't said — key claims? risks? supporting evidence? quotes? The `--instructions` flag focuses the AI on what matters.
- **Density is the main tuning knob.** Start around 5 for selective highlighting. Go up to 10–15 for dense annotation of dense technical material. Go down to 1–3 for a light editorial pass.
- **Only `text/plain` and `text/markdown` resources are supported.** PDFs and images are not yet supported.
- **Check results** with `semiont browse resources --resource <id>` or `client.getResourceAnnotations(rId)` — filter for `motivation === 'highlighting'`.
- **Manual mode is for corrections.** If the AI missed a specific passage, add it manually. Don't re-run delegate just to capture one passage.
- **The `mark:assist-finished` event payload** includes `{ motivation, resourceId, progress: { createdCount } }`.
- **Always destroy the EventBus** after the stream completes to avoid memory leaks.
