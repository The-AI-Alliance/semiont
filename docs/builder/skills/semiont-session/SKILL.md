---
name: semiont-session
description: Drive @semiont/sdk's SemiontSession for long-running scripts — token refresh, bus event subscription, lifecycle observables, graceful shutdown
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user build a long-running Semiont script: a watcher or a daemon, anything that stays up and reacts to what happens in a knowledge base. The other skills sign in the same way and run to completion. This one covers what a `SemiontSession` gives a script that keeps running.

A watcher listens to the bus and reacts. A daemon that claims queued jobs and reports their progress is a worker, which is [`semiont-worker`](../semiont-worker/SKILL.md).

## What a session does

- **Keeps the token fresh.** An access token is short-lived (five minutes from the Keycloak a launcher stack runs). The session renews it before it expires, half its lifetime ahead and never more than five minutes, and writes the new token where the transport reads it. A request the gateway refuses is answered with one renewal as well. Your calls never see the change.
- **Stores the tokens.** The access and refresh tokens are kept through a `SessionStorage` you supply. `InMemorySessionStorage` ships in `@semiont/sdk`.
- **Subscribes to the bus.** `session.subscribe(channel, handler)` listens to one channel and returns a function that stops listening. Channels are typed: the handler's argument is that channel's payload.
- **Reports its own state.** `session.token$`, `session.user$`, `session.streamState$` (the event stream's connection: `connecting`, `open`, `reconnecting`, `degraded`, `unauthenticated`, `closed`) and `session.errors$` (each transport error, just before it is thrown to its caller).

A script that already holds an access token and finishes before it expires can use `SemiontClient.fromHttp({ baseUrl, token })` with no session at all.

## Sign in

`SemiontSession.signInDevice(...)` runs the device authorization grant (RFC 8628) against the knowledge base's issuer: the issuer mints a code, `onCode` shows the person where to approve it, and no password passes through the script. It stores the tokens the grant returned and renews the access token at the issuer's token endpoint with the refresh token, so there is no refresh callback for you to write.

`kb.id` is the key the session's tokens are stored under. Two scripts that share one storage must use different ids.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');

const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'watcher', label: 'Long-running watcher',
    host: url.hostname, port: Number(url.port || 4000),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  }),
  storage: new InMemorySessionStorage(),
  onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
    console.error(`Approve this session at ${verificationUriComplete ?? verificationUri}`);
    if (!verificationUriComplete) console.error(`Code: ${userCode}`);
  },
  onAuthFailed: (reason) => console.error(`The session ended: ${reason}`),
  onError: (err) => console.error('session error:', err.code, err.message),
});

const me = await session.client.auth?.me();
console.error(`Signed in as ${me?.email}`);
```

`onAuthFailed` is called once, when the session ends: `expired` when the issuer would not renew it, `refused` when the gateway would not accept a token the issuer had just issued. Neither is a prompt to retry, because the session already did. Signing in again is what is left.

Every verb is on `session.client`: `session.client.mark.assist(...)`, `session.client.gather.annotation(...)` and so on.

A script that gets its token some other way, such as a service account's client-credentials grant, builds the session with `SemiontSession.fromHttp({ kb, storage, baseUrl, token, refresh })` and supplies `refresh` itself.

## Keeping tokens across restarts

With `InMemorySessionStorage` the script signs in again every time it starts. To keep the tokens, implement `SessionStorage` over a file. It is three methods:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionStorage } from '@semiont/sdk';

class FileSessionStorage implements SessionStorage {
  private map = new Map<string, string>();

  constructor(private readonly path: string) {
    try {
      const stored: Record<string, string> = JSON.parse(readFileSync(path, 'utf-8'));
      this.map = new Map(Object.entries(stored));
    } catch {
      // No file yet: start empty.
    }
  }

  get(key: string): string | null { return this.map.get(key) ?? null; }
  set(key: string, value: string): void { this.map.set(key, value); this.flush(); }
  delete(key: string): void { this.map.delete(key); this.flush(); }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
  }
}

const stateHome = process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`;
const storage = new FileSessionStorage(`${stateHome}/semiont/watcher.json`);
```

The file holds a refresh token, so keep it readable by its owner only. The interface's optional `subscribe` method tells a session that another process changed the file; leave it out unless several processes share one.

## Which channels reach a script

A channel's audience decides who hears it.

**Delivered to everyone.** Any signed-in connection hears these: a resource was created (`yield:created`), a job's progress and end (`job:report-progress`, `job:complete`, `job:fail`), who is watching (`session:joined`, `session:left`), where a participant arrived (`browse:resource-viewed`).

```typescript
const stopCreated = session.subscribe('yield:created', (event) => {
  console.log(`new resource ${event.resourceId}: ${event.payload.name}`);
});

const stopProgress = session.subscribe('job:report-progress', (event) => {
  console.log(`job ${event.jobId}: ${event.percentage}%`);
});
```

**Delivered to a resource's scope.** What happens to one resource's annotations (`mark:added`, `mark:removed`, `mark:body-updated`) reaches only the connections that joined that resource's scope. A script that subscribes to `mark:added` and joins no scope hears nothing.

Subscribing to a live query joins its resource's scope and leaves it on unsubscribe. This is the simple way to follow one resource:

```typescript
const following = semiont.browse.annotations(rId).subscribe((state) => {
  if (state.status === 'ready') console.log(`${state.value.length} annotations`);
});

// later
following.unsubscribe();
```

To handle the events themselves, join the scope and subscribe to the channel. `mark:added` carries the annotation as it stands:

```typescript
const leave = session.client.transport.subscribeToResource(rId);

const stopAdded = session.subscribe('mark:added', (event) => {
  if (event.annotation?.motivation === 'linking') {
    console.log(`new reference ${event.annotation.id}`);
  }
});

// later
stopAdded();
leave();
```

Scopes compose on the one connection, so a script can join many resources.

The channels and their audiences are in [CHANNELS.md](../../../protocol/CHANNELS.md).

## A complete watcher

This daemon detects references in every resource as it is created.

```typescript
import {
  SemiontSession, InMemorySessionStorage, httpKb, entityType, type ResourceId,
} from '@semiont/sdk';

const ENTITY_TYPES = (process.env.ENTITY_TYPES ?? 'Person').split(',').map((t) => entityType(t.trim()));

async function main(): Promise<void> {
  const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'watcher', label: 'Long-running watcher',
      host: url.hostname, port: Number(url.port || 4000),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    }),
    storage: new InMemorySessionStorage(),
    onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
      console.error(`Approve this session at ${verificationUriComplete ?? verificationUri}`);
      if (!verificationUriComplete) console.error(`Code: ${userCode}`);
    },
    onAuthFailed: (reason) => {
      console.error(`The session ended: ${reason}`);
      process.exit(1);
    },
    onError: (err) => console.error('session error:', err.code, err.message),
  });

  async function detect(rId: ResourceId): Promise<void> {
    const done = await session.client.mark.assist(rId, 'linking', { entityTypes: ENTITY_TYPES });
    const result = done.kind === 'complete' ? done.data.result : undefined;
    if (result?.kind === 'reference-annotation') {
      console.log(`${rId}: ${result.totalEmitted} references`);
    }
  }

  const stopCreated = session.subscribe('yield:created', (event) => {
    if (!event.resourceId) return;
    // Start the work and return, with a catch: nothing awaits a handler.
    detect(event.resourceId).catch((err) => console.error(`detection failed for ${event.resourceId}:`, err));
  });

  async function shutdown(): Promise<void> {
    stopCreated();
    await session.dispose();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Watching for new resources. Ctrl-C to exit.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`session.dispose()` cancels the renewal timer and closes the event stream. Without it the open stream keeps the process alive.

## Guidance for the AI assistant

- **Check the channel's audience before you subscribe.** A watcher that hears nothing is usually subscribed to a resource-scoped channel without having joined the scope.
- **A watcher hears its own writes.** A daemon that creates resources in response to `yield:created` hears those too. Decide what stops the loop: an entity type it skips, or a check on who created the resource.
- **Nothing awaits a handler.** Start the work, attach a `.catch`, and return. A rejection from an `async` handler goes unhandled.
- **`signInDevice` handles renewal.** Write a `refresh` callback only when the token comes from somewhere other than the device grant, and then build the session with `fromHttp`.
- **Choose storage by what a restart should do.** In memory, the script signs in again at every start. On disk, it resumes.
- **Prefer a namespace method to a channel.** `mark.assist`, `yield.fromContext` and the others follow their own jobs and replies. Subscribe to a channel only for what no method covers.
- **Two kinds of error.** A call rejects with a `SemiontError`: catch it and route on its `code`, narrowing to `BusRequestError` or `JobFailedError` where that helps. A failure of the session itself (`session.refresh-exhausted`, `session.credential-refused`) arrives at `onError` as a `SemiontSessionError`, and the session's end at `onAuthFailed`. See [Error Handling](../../Usage.md#error-handling).
- **From the command line.** `semiont listen --channel <name>` prints a channel's events, and `--scope <resourceId>` joins a resource's scope. Use it to see what a channel carries before writing the handler.
