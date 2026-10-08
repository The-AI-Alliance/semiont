---
name: semiont-assess
description: Add assessment annotations to a Semiont resource — flag scheduling risks, dangers, inaccuracies, logical gaps, or other evaluative concerns, by delegating the pass to the knowledge base's worker or by hand
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add assessment annotations to a Semiont resource. An assessment evaluates a passage: a risk, a danger, an inaccuracy, a logical gap, a questionable assumption, or anything that deserves scrutiny.

This skill works in the annotation layer of [the layered data model](../README.md#the-layers). An `assessing` annotation is a span anyone can query, so an aggregating skill such as [`semiont-aggregate`](../semiont-aggregate/SKILL.md) can roll assessments up into a checklist, a risk report or a due-diligence summary.

## Two modes

**Delegate.** `mark.delegate` with motivation `assessing` has the worker read the whole resource and assess it. Use it for a systematic review.

**Manual.** `mark.annotation` writes one assessment on a passage you name. Use it for a known issue.

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs), so a session, not a bare client, is what keeps a script working past that. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

A script that already holds an access token can use `SemiontClient.fromHttp({ baseUrl, token })` and skip the sign-in, but then nothing renews the token.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-assess', label: 'Semiont',
    host: url.hostname, port: Number(url.port || 4000),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  }),
  storage: new InMemorySessionStorage(),
  onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
    console.error(`Approve this script at ${verificationUriComplete ?? verificationUri}`);
    if (!verificationUriComplete) console.error(`Code: ${userCode}`);
  },
});
const semiont = session.client;
```

## Delegate

`semiont.mark.delegate(rId, params)` creates a job for the stack's worker and follows it to its end. The params state the job's `motivation` and what that motivation takes: an assessing job takes `instructions`, `density`, `tone`, `language` and `sourceLanguage`. It returns a `DelegationObservable`. Read, it gives the job's events, and each has a `kind`:

- `progress`: the worker's report, with a `percentage`.
- `failed`: one attempt failed and the queue is running the job again.
- `complete`: the job's end, with its completion as `data`.

Awaiting the call resolves to the completion itself, the `job:complete` the job ended with. Its `result` is a `mark` job's, one of two. A job that did its work gives its counts: `found` is what the model proposed, `persisted` is what was written, and `errors`, present only when there were some, is how many of the proposed could not be anchored in the text. A resource whose text could not be read gives a decline, `{ declined: true, reason }`. One check tells the two apart.

```typescript
import { resourceId } from '@semiont/sdk';

const rId = resourceId('doc-123');

const done = await semiont.mark.delegate(rId, {
  motivation: 'assessing',
  tone: 'critical',
  instructions: 'Flag scheduling risks, resource conflicts, and unverified safety assumptions',
  density: 4,
});

const { result } = done;
if (result && 'declined' in result) {
  console.log(`The resource's text could not be read: ${result.reason}`);
} else if (result) {
  console.log(`Created ${result.persisted} of ${result.found} assessments`);
}

await session.dispose();
```

To watch progress as well, call `.run(onEvent)`. It subscribes once and resolves to the same completion:

```typescript
const done = await semiont.mark.delegate(rId, { motivation: 'assessing', density: 4, tone: 'critical' }).run((event) => {
  if (event.kind === 'progress') console.log(`${event.data.percentage}%`);
});
```

Consume one call one way. The delegation is cold, so awaiting a call and also subscribing to it creates the job twice.

The call has no deadline of its own. If the job says nothing for ten seconds, the SDK asks for the job's status and keeps asking until the job ends, so a dropped connection does not lose the result. A job that fails for good rejects with `JobFailedError`, and a cancelled one with `JobCancelledError`.

## Manual

The assessment's text is a body whose purpose is `assessing`.

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
    value: 'This assumption is unverified: the timeline assumes Q3 availability, but procurement lead time is typically 16 weeks.',
    purpose: 'assessing',
  }],
});
```

## Complete script

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb, resourceId } from '@semiont/sdk';

const TONES = ['analytical', 'critical', 'balanced', 'constructive'] as const;

/** The tone to write in. An assessing job takes one of its four and refuses any other. */
function assessTone(): (typeof TONES)[number] {
  const wanted = process.env.ASSESS_TONE ?? 'balanced';
  const tone = TONES.find((t) => t === wanted);
  if (!tone) throw new Error(`ASSESS_TONE must be one of: ${TONES.join(', ')}`);
  return tone;
}

async function assess(resourceIdStr: string): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-assess', label: 'Semiont',
      host: url.hostname, port: Number(url.port || 4000),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    }),
    storage: new InMemorySessionStorage(),
    onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
      console.error(`Approve this script at ${verificationUriComplete ?? verificationUri}`);
      if (!verificationUriComplete) console.error(`Code: ${userCode}`);
    },
  });
  const semiont = session.client;

  try {
    const done = await semiont.mark.delegate(resourceId(resourceIdStr), {
      motivation: 'assessing',
      tone: assessTone(),
      instructions: process.env.ASSESS_INSTRUCTIONS ?? 'Flag risks, gaps, and unverified assumptions in this document',
      density: Number(process.env.ASSESS_DENSITY ?? 4),
    });

    const { result } = done;
    if (result && 'declined' in result) {
      console.log(`The resource's text could not be read: ${result.reason}`);
    } else if (result) {
      console.log(`Created ${result.persisted} of ${result.found} assessments`);
    }
  } finally {
    await session.dispose();
  }
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

- **Ask what kind of concern to surface.** Assessment is broad: scheduling risks, safety hazards, logical errors, factual inaccuracies, missing evidence, legal exposure, compliance gaps. Without `instructions` the model flags generic risks.
- **Choose a tone.** The four written for assessment:
  - `analytical`: systematic and detached
  - `critical`: adversarial, probing for weaknesses before a reviewer finds them
  - `balanced`: notes strengths and concerns
  - `constructive`: flags a problem and suggests an improvement
- **Density** is the number of assessments to aim for in each 2,000 words; the Browser offers 1 to 10. Start at 3 to 5 for a focused review, and go higher only for dense technical or legal text where nearly every claim deserves scrutiny.
- **Assessment, comment or tag.** An assessment flags a problem. A comment helps the author revise or a reader understand. A tag classifies against a controlled vocabulary.
- **Assessments feed aggregates.** To roll every flagged risk in a matter into one checklist or report, assess first and then run [`semiont-aggregate`](../semiont-aggregate/SKILL.md).
- **What `mark.delegate` can read.** A resource with text: Markdown, plain text, HTML, JSON, or a PDF. A resource with no text at all, such as an image, fails the job. A document whose text could not be read (an encrypted or damaged PDF, or one that yields no text) completes with a `declined` result and a reason code.
- **Check results** with `await semiont.browse.annotations(rId).fresh()`, filtered with `isAssessment` from `@semiont/sdk`.
- **Manual mode is for known issues.** Delegate discovers; manual records what the user already found.
- **From the command line.** `semiont mark --delegate <resourceId> --motivation assessing` runs the same job from the [launcher](../../../../apps/launcher/README.md#delegating-to-the-stack), with `--instructions`, `--density` and `--tone`. Use it for a one-off; write a script when the work repeats.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. `BusRequestError` (a bus request, with a code such as `bus.timeout`) and `JobFailedError` narrow it. See [Error Handling](../../Usage.md#error-handling).
