---
name: semiont-assess
description: Add assessment annotations to a Semiont resource — flag scheduling risks, dangers, inaccuracies, logical gaps, or other evaluative concerns using AI-assisted or manual assessment
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add assessment annotations to a Semiont resource. Assessments are evaluative annotations that flag passages for attention — risks, dangers, inaccuracies, logical gaps, questionable assumptions, or anything warranting critical scrutiny.

## Two modes

**Delegate (AI-assisted)** — the API generates assessments autonomously from the document content. Use this for systematic review.

**Manual** — the user specifies the exact passage to assess. Use this for targeted flags.

## CLI — delegate

```bash
semiont mark --resource <id> --delegate --motivation assessing \
  [--tone analytical|critical|balanced|constructive] \
  [--instructions "<what to flag>"] \
  [--density <1-10>]
```

- `--tone` shapes the evaluative stance (default: `balanced`):
  - `analytical` — systematic, detached analysis
  - `critical` — adversarial, probes weaknesses
  - `balanced` — notes both strengths and concerns
  - `constructive` — flags problems with improvement suggestions
- `--instructions` guides what kind of issues to surface, e.g. `"flag scheduling risks and resource conflicts"` or `"identify safety assumptions that need verification"`
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
  motivation: 'assessing',
  options: {
    tone: 'critical',
    instructions: 'Flag scheduling risks, resource conflicts, and unverified safety assumptions',
    density: 4,
  },
});

const finished = await firstValueFrom(
  eventBus.get('mark:assist-finished').pipe(
    filter((e) => e.motivation === 'assessing'),
  ),
);

console.log(`Created ${finished.progress?.createdCount ?? 0} assessments`);

markVM.dispose();
eventBus.destroy();
```

## TypeScript — manual

```typescript
await client.mark.annotation(rId, {
  motivation: 'assessing',
  target: {
    source: rId,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'the passage being flagged',
      prefix: 'words before ',
      suffix: ' words after',
    },
  },
  body: [{
    type: 'TextualBody',
    value: 'This assumption is unverified — the timeline assumes Q3 availability but procurement lead time is typically 16 weeks.',
    purpose: 'describing',
  }],
});
```

## Guidance for the AI assistant

- **Ask what kind of concerns to surface.** Assessment is broad — scheduling risks, safety hazards, logical errors, factual inaccuracies, missing evidence, legal exposure, compliance gaps. The `--instructions` flag is critical here.
- **Tone selection matters:**
  - Use `critical` for adversarial review (finding holes before reviewers do)
  - Use `constructive` when the goal is improvement, not just criticism
  - Use `analytical` for detached technical evaluation
  - Use `balanced` when the author should see both positives and negatives
- **Density is lower for assessments** (1-10 vs. 1-15 for highlights). Start at 3-5 for a focused review. Only go higher for dense technical or legal documents where nearly every claim warrants scrutiny.
- **Only `text/plain` and `text/markdown` resources are supported.** PDFs and images are not yet supported.
- **Manual mode is for known issues.** If the user has already identified a problem and wants to attach it to the document, use manual mode. Delegate is for discovery.
- **Check results** with `client.browse.annotations(rId)` — filter for `motivation === 'assessing'`.
