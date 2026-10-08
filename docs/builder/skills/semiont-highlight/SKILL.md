---
name: semiont-highlight
description: Add highlighting annotations to a Semiont resource — mark key passages, important claims, or noteworthy content, by delegating the pass to the knowledge base's worker or by hand
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user add highlighting annotations to a Semiont resource. Highlights mark passages worth a reader's attention: key claims, important evidence, surprising findings, or anything the user wants to surface.

This skill works in the annotation layer of [the layered data model](../README.md#the-layers). A `highlighting` annotation is a span anyone can query, so a later skill or the Browser can surface what was marked.

## Two modes

**Delegate.** `mark.delegate` with motivation `highlighting` has the worker read the whole resource and highlight it. Use it for bulk highlighting.

**Manual.** `mark.annotation` writes one highlight on a passage you name. Use it for a correction or an addition.

## Sign in

`SemiontSession.signInDevice(...)` signs a person in at the knowledge base's issuer with the device authorization grant (RFC 8628): the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. The session then keeps the token fresh. An access token is short-lived (five minutes from the Keycloak a launcher stack runs), so a session, not a bare client, is what keeps a script working past that. Sign in once, use `session.client` for every call, and `await session.dispose()` when done.

A script that already holds an access token can use `SemiontClient.fromHttp({ baseUrl, token })` and skip the sign-in, but then nothing renews the token.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'semiont-highlight', label: 'Semiont',
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

`semiont.mark.delegate(rId, params)` creates a job for the stack's worker and follows it to its end. The params state the job's `motivation` and what that motivation takes: a highlighting job takes `instructions`, `density` and `sourceLanguage`. It returns a `DelegationObservable`. Read, it gives the job's events, and each has a `kind`:

- `progress`: the worker's report, with a `percentage`.
- `failed`: one attempt failed and the queue is running the job again.
- `complete`: the job's end, with its completion as `data`.

Awaiting the call resolves to the completion itself, the `job:complete` the job ended with. Its `result` is a `mark` job's, one of two. A job that did its work gives its counts: `found` is what the model proposed, `persisted` is what was written, and `errors`, present only when there were some, is how many of the proposed could not be anchored in the text. A resource whose text could not be read gives a decline, `{ declined: true, reason }`. One check tells the two apart.

```typescript
import { resourceId } from '@semiont/sdk';

const rId = resourceId('doc-123');

const done = await semiont.mark.delegate(rId, {
  motivation: 'highlighting',
  instructions: 'Focus on key claims and supporting evidence',
  density: 5,
});

const { result } = done;
if (result && 'declined' in result) {
  console.log(`The resource's text could not be read: ${result.reason}`);
} else if (result) {
  console.log(`Created ${result.persisted} of ${result.found} highlights`);
}

await session.dispose();
```

To watch progress as well, call `.run(onEvent)`. It subscribes once and resolves to the same completion:

```typescript
const done = await semiont.mark.delegate(rId, { motivation: 'highlighting', density: 5 }).run((event) => {
  if (event.kind === 'progress') console.log(`${event.data.percentage}%`);
});
```

Consume one call one way. The delegation is cold, so awaiting a call and also subscribing to it creates the job twice.

The call has no deadline of its own. If the job says nothing for ten seconds, the SDK asks for the job's status and keeps asking until the job ends, so a dropped connection does not lose the result. A job that fails for good rejects with `JobFailedError`, and a cancelled one with `JobCancelledError`.

## Manual

A highlight has no body: the motivation on a target is the whole annotation.

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
});
```

## Complete script

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb, resourceId } from '@semiont/sdk';

async function highlight(resourceIdStr: string): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'semiont-highlight', label: 'Semiont',
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
      motivation: 'highlighting',
      instructions: process.env.HIGHLIGHT_INSTRUCTIONS ?? 'Focus on key claims and supporting evidence',
      density: Number(process.env.HIGHLIGHT_DENSITY ?? 5),
    });

    const { result } = done;
    if (result && 'declined' in result) {
      console.log(`The resource's text could not be read: ${result.reason}`);
    } else if (result) {
      console.log(`Created ${result.persisted} of ${result.found} highlights`);
    }
  } finally {
    await session.dispose();
  }
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

- **Ask what to highlight** if the user has not said: key claims, risks, supporting evidence, quotes. `instructions` is how the model learns what matters.
- **Density is the main dial.** It is the number of highlights to aim for in each 2,000 words; the Browser offers 1 to 15. Start near 5 for a selective pass, go to 10 or more for dense technical material, and to 1 to 3 for a light editorial pass.
- **What `mark.delegate` can read.** A resource with text: Markdown, plain text, HTML, JSON, or a PDF. A resource with no text at all, such as an image, fails the job. A document whose text could not be read (an encrypted or damaged PDF, or one that yields no text) completes with a `declined` result and a reason code.
- **Check results** with `await semiont.browse.annotations(rId).fresh()`, filtered for `motivation === 'highlighting'`.
- **Manual mode is for corrections.** If the model missed one passage, add it by hand instead of running the job again.
- **From the command line.** `semiont mark --delegate <resourceId> --motivation highlighting` runs the same job from the [launcher](../../../../apps/launcher/README.md#delegating-to-the-stack), with `--instructions`, `--density`. Use it for a one-off; write a script when the work repeats.
- **Errors.** Every SDK throw extends `SemiontError`: catch it and route on its `code`. `BusRequestError` (a bus request, with a code such as `bus.timeout`) and `JobFailedError` narrow it. See [Error Handling](../../Usage.md#error-handling).
