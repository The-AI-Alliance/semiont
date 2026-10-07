---
name: semiont-comment
description: Add commenting annotations to a Semiont resource — suggest edits, ask questions of the author, or point things out to readers using AI-assisted or manual commenting
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add commenting annotations to a Semiont resource. A comment is attached to a passage and says something about it: an editorial suggestion, a question for the author, a clarification for readers, or an observation that is neither an assessment nor a highlight.

This skill works in the annotation layer of [the layered data model](../README.md#the-layers). A `commenting` annotation is a span anyone can query, and its body is the comment's text.

## Two modes

**Delegate.** `mark.delegate` with motivation `commenting` has the worker read the whole resource and comment on it. Use it for a systematic editorial review.

**Manual.** `mark.annotation` writes one comment on a passage you name. Use it when the user knows what to say and where.

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs), so a session, not a bare client, is what keeps a script working past that. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

A script that already holds an access token can use `SemiontClient.fromHttp({ baseUrl, token })` and skip the sign-in, but then nothing renews the token.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-comment', label: 'Semiont',
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

`semiont.mark.delegate(rId, params)` creates a job for the stack's worker and follows it to its end. The params state the job's `motivation` and what that motivation takes: a commenting job takes `instructions`, `density`, `tone`, `language` and `sourceLanguage`. It returns a `DelegationObservable`. Read, it gives the job's events, and each has a `kind`:

- `progress`: the worker's report, with a `percentage`.
- `failed`: one attempt failed and the queue is running the job again.
- `complete`: the job's end, with its completion as `data`.

Awaiting the call resolves to the completion itself, the `job:complete` the job ended with. Its `result` is a `mark` job's, one of two. A job that did its work gives its counts: `found` is what the model proposed, `persisted` is what was written, and `errors`, present only when there were some, is how many of the proposed could not be anchored in the text. A resource whose text could not be read gives a decline, `{ declined: true, reason }`. One check tells the two apart.

```typescript
import { resourceId } from '@semiont/sdk';

const rId = resourceId('doc-123');

const done = await semiont.mark.delegate(rId, {
  motivation: 'commenting',
  tone: 'conversational',
  instructions: 'Suggest edits to improve clarity and ask questions where the reasoning is unclear',
  density: 5,
});

const { result } = done;
if (result && 'declined' in result) {
  console.log(`The resource's text could not be read: ${result.reason}`);
} else if (result) {
  console.log(`Created ${result.persisted} of ${result.found} comments`);
}

await session.dispose();
```

To watch progress as well, call `.run(onEvent)`. It subscribes once and resolves to the same completion:

```typescript
const done = await semiont.mark.delegate(rId, { motivation: 'commenting', density: 5 }).run((event) => {
  if (event.kind === 'progress') console.log(`${event.data.percentage}%`);
});
```

Consume one call one way. The delegation is cold, so awaiting a call and also subscribing to it creates the job twice.

The call has no deadline of its own. If the job says nothing for ten seconds, the SDK asks for the job's status and keeps asking until the job ends, so a dropped connection does not lose the result. A job that fails for good rejects with `JobFailedError`, and a cancelled one with `JobCancelledError`.

## Manual

The comment's text is a body whose purpose is `commenting`.

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
    value: 'Consider reordering this paragraph: the conclusion appears before the supporting evidence.',
    purpose: 'commenting',
  }],
});
```

## Complete script

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb, resourceId } from '@semiont/sdk';

const TONES = ['scholarly', 'explanatory', 'conversational', 'technical'] as const;

/** The tone to write in. A commenting job takes one of its four and refuses any other. */
function commentTone(): (typeof TONES)[number] {
  const wanted = process.env.COMMENT_TONE ?? 'conversational';
  const tone = TONES.find((t) => t === wanted);
  if (!tone) throw new Error(`COMMENT_TONE must be one of: ${TONES.join(', ')}`);
  return tone;
}

async function comment(resourceIdStr: string): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-comment', label: 'Semiont',
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
      motivation: 'commenting',
      tone: commentTone(),
      instructions: process.env.COMMENT_INSTRUCTIONS ?? 'Suggest edits to improve clarity and ask questions where the reasoning is unclear',
      density: Number(process.env.COMMENT_DENSITY ?? 5),
    });

    const { result } = done;
    if (result && 'declined' in result) {
      console.log(`The resource's text could not be read: ${result.reason}`);
    } else if (result) {
      console.log(`Created ${result.persisted} of ${result.found} comments`);
    }
  } finally {
    await session.dispose();
  }
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

- **Ask who the comments are for.** A comment can address the author ("you should clarify…"), readers ("note that…") or collaborators ("this contradicts section 3"). `instructions` sets the audience and the purpose.
- **Choose a tone.** The four written for comments:
  - `scholarly`: peer review, academic manuscripts, formal reports
  - `explanatory`: onboarding material, tutorials, writing for end users
  - `conversational`: collaborative drafts and editorial passes
  - `technical`: API documentation, specifications, engineering documents
- **Density** is the number of comments to aim for in each 2,000 words; the Browser offers 2 to 12. Start at 4 to 6 for a moderate editorial pass. 8 to 12 suits line editing of a short document.
- **Comment, assessment or tag.** A comment helps the author revise or a reader understand. An assessment flags a problem. A tag classifies against a controlled vocabulary.
- **What `mark.delegate` can read.** A resource with text: Markdown, plain text, HTML, JSON, or a PDF. A resource with no text at all, such as an image, fails the job. A document whose text could not be read (an encrypted or damaged PDF, or one that yields no text) completes with a `declined` result and a reason code.
- **Check results** with `await semiont.browse.annotations(rId).fresh()`, filtered for `motivation === 'commenting'`.
- **Manual mode is for targeted feedback.** When the user knows what to say about one passage, writing it by hand is faster and more exact than a job.
- **From the command line.** `semiont mark --delegate <resourceId> --motivation commenting` runs the same job from the [launcher](../../../../apps/launcher/README.md#delegating-to-the-stack), with `--instructions`, `--density` and `--tone`. Use it for a one-off; write a script when the work repeats.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. `BusRequestError` (a bus request, with a code such as `bus.timeout`) and `JobFailedError` narrow it. See [Error Handling](../../Usage.md#error-handling).
