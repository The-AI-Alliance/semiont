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

## Session setup (shared by all TypeScript examples below)

Scripts drive the API through a `SemiontSession`. Construct it once at the top of a script and reuse the same session for every verb call.

```typescript
import {
  SemiontSession,
  InMemorySessionStorage,
  setStoredSession,
  resourceId,
  type KnowledgeBase,
} from '@semiont/api-client';
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
  refresh: async () => null,
});
await session.ready;
```

## TypeScript — delegate

`session.client.mark.assist(...)` returns an `Observable<MarkAssistProgress>`. `lastValueFrom` resolves with the final progress payload once the job completes.

```typescript
const rId = resourceId('doc-123');

const progress = await lastValueFrom(
  session.client.mark.assist(rId, 'assessing', {
    tone: 'critical',
    instructions: 'Flag scheduling risks, resource conflicts, and unverified safety assumptions',
    density: 4,
  }),
);

console.log(`Created ${progress.progress?.createdCount ?? 0} assessments`);

await session.dispose();
```

The namespace method handles SSE streaming, timeout (180 s without progress), and polling fallback internally.

## TypeScript — manual

```typescript
await session.client.mark.annotation(rId, {
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
- **Check results** with `session.client.browse.annotations(rId)` — filter for `motivation === 'assessing'`.
