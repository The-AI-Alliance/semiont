---
name: semiont-assess
description: Add assessment annotations to a Semiont resource — flag scheduling risks, dangers, inaccuracies, logical gaps, or other evaluative concerns using AI-assisted or manual assessment
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add assessment annotations to a Semiont resource. Assessments are evaluative annotations that flag passages for attention — risks, dangers, inaccuracies, logical gaps, questionable assumptions, or anything warranting critical scrutiny.

This skill builds **Layer #2 (Annotations)** of the layered data model — `assessing`-motivation annotations are first-class queryable spans that downstream aggregator skills (e.g. *Compose aggregates* — see [`semiont-aggregate`](../semiont-aggregate/SKILL.md)) can roll up into checklists, risk reports, or due-diligence summaries.

## Two modes

**Delegate (AI-assisted)** — `mark.assist` with motivation `assessing` runs the evaluative pass autonomously across the document. Use this for systematic review.

**Manual** — explicit `mark.annotation` with an `assessing` body item. Use this for a known issue on a specific passage.

## Client setup

`SemiontSession.signInHttp(...)` is the credentials-first construction. It calls `auth.password(email, password)`, then owns the token lifecycle — the access token lives **ten minutes**, so a session (not a bare client) is what keeps a script working past that. Construct once at the top and reuse `session.client` for every verb call; `await session.dispose()` when done.

Already hold an access token (cached from a prior auth, or supplied by an embedding host)? `SemiontClient.fromHttp({ baseUrl, token })` skips the auth round-trip — but you then own refresh yourself.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb, resourceId } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInHttp({
  kb: httpKb({
    id: 'semiont-assess', label: 'Semiont', email: process.env.SEMIONT_USER_EMAIL!,
    host: url.hostname, port: Number(url.port || 4000),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  }),
  storage: new InMemorySessionStorage(),
  baseUrl: url.href,
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
const semiont = session.client;
```

## Delegate (AI-assisted)

`semiont.mark.assist(...)` returns a `StreamObservable<MarkAssistProgress>` — an Observable that's also awaitable. `await` resolves with the final progress payload once the job completes.

```typescript
const rId = resourceId('doc-123');

const progress = await semiont.mark.assist(rId, 'assessing', {
  tone: 'critical',
  instructions: 'Flag scheduling risks, resource conflicts, and unverified safety assumptions',
  density: 4,
});

console.log(`Created ${progress.progress?.createdCount ?? 0} assessments`);

await session.dispose();
```

The namespace method handles SSE streaming, timeout (180 s without progress), and polling fallback internally.

To observe intermediate progress, subscribe directly instead of awaiting:

```typescript
semiont.mark.assist(rId, 'assessing', { density: 4, tone: 'critical' }).subscribe({
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
      exact: 'the passage being flagged',
      prefix: 'words before ',
      suffix: ' words after',
    },
  },
  motivation: 'assessing',
  body: [{
    type: 'TextualBody',
    value: 'This assumption is unverified — the timeline assumes Q3 availability but procurement lead time is typically 16 weeks.',
    purpose: 'describing',
  }],
});
```

## Complete script skeleton

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb, resourceId } from '@semiont/sdk';

async function assess(resourceIdStr: string): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInHttp({
    kb: httpKb({
      id: 'semiont-assess', label: 'Semiont', email: process.env.SEMIONT_USER_EMAIL!,
      host: url.hostname, port: Number(url.port || 4000),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    }),
    storage: new InMemorySessionStorage(),
    baseUrl: url.href,
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });
  const semiont = session.client;
  const rId = resourceId(resourceIdStr);

  const progress = await semiont.mark.assist(rId, 'assessing', {
    tone: process.env.ASSESS_TONE ?? 'balanced',
    instructions: process.env.ASSESS_INSTRUCTIONS ??
      'Flag risks, gaps, and unverified assumptions in this document',
    density: Number(process.env.ASSESS_DENSITY ?? 4),
  });

  console.log(`Created ${progress.progress?.createdCount ?? 0} assessments`);
  await session.dispose();
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx assess.ts <resourceId>');
  process.exit(1);
}
assess(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Ask what kind of concerns to surface.** Assessment is broad — scheduling risks, safety hazards, logical errors, factual inaccuracies, missing evidence, legal exposure, compliance gaps. The `instructions` parameter is critical here; without it the model defaults to generic risk-flagging.
- **Tone selection matters** (default: `balanced`):
  - `analytical` — systematic, detached analysis
  - `critical` — adversarial, probes weaknesses (use for finding holes before reviewers do)
  - `balanced` — notes both strengths and concerns
  - `constructive` — flags problems with improvement suggestions
- **Density is lower for assessments** (1-10 vs. 1-15 for highlights). Start at 3-5 for a focused review. Only go higher for dense technical or legal documents where nearly every claim warrants scrutiny.
- **Only `text/plain` and `text/markdown` resources are supported** for `mark.assist`. PDFs and images are not yet supported.
- **Manual mode is for known issues.** If the user has already identified a problem and wants to attach it to the document, use manual mode. Delegate is for discovery.
- **Distinguish from comments and tags.** Assessments flag objective concerns warranting attention. Comments are for dialogue and editorial improvement. Tags classify against a controlled vocabulary. Reach for `assessing` when the goal is to flag a problem; for `commenting` when the goal is to help the author revise; for `tagging` when the goal is controlled-vocabulary classification.
- **Assessments feed aggregators.** When you want every flagged risk in a matter rolled up into a single Checklist or due-diligence report, write an aggregate skill on top — see [`semiont-aggregate`](../semiont-aggregate/SKILL.md). Tag-first / assess-first / comment-first, then aggregate.
- **Check results** with `semiont.browse.annotations(rId)` — filter for `motivation === 'assessing'`.
- **Launcher shortcut.** The `semiont` launcher (see [apps/launcher](../../../../apps/launcher/README.md)) exposes these operations as verbs for one-off invocations. The SDK is primary; the launcher is a convenience for ad-hoc work.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated, with codes like `bus.timeout`). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
