---
name: semiont-session
description: Drive @semiont/sdk's SemiontSession for long-running scripts — token refresh, bus event subscription, lifecycle observables, graceful shutdown
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user build a long-running Semiont script — a watcher, a daemon, a queue worker, anything that runs longer than a single token's 24-hour lifetime. The lighter `SemiontClient` setup the other skills use is fine for one-shot scripts; for anything that needs to keep working after a token expires, `SemiontSession` from `@semiont/sdk` owns the refresh, validation, and storage machinery for you.

## Why SemiontSession over bare SemiontClient

`SemiontClient + HttpTransport` is enough if your script runs to completion before its access token expires. `SemiontSession` adds:

- **Proactive token refresh.** The session schedules a refresh ~5 minutes before expiry and writes the new token into the same `token$` the transport reads from. Your namespace calls don't see the token rollover.
- **Startup validation.** A `validate` callback runs once on `ready`, populating `session.user$`. Catches stale-on-disk tokens before the first real call fails.
- **Storage adapter.** Tokens persist across process restarts via a `SessionStorage` you supply. `InMemorySessionStorage` ships in `@semiont/sdk`; CLI/daemon scripts typically wire a small filesystem-backed adapter.
- **Generic-channel subscribe.** `session.subscribe(channel, handler)` is the sanctioned escape hatch for watching arbitrary bus channels — useful when the channel name is dynamic or when you want to react to events you don't have a typed namespace method for.
- **Lifecycle observables.** `session.user$`, `session.token$`, `session.streamState$` (HTTP transport's connection health). Useful for status-reporting daemons.

If none of those apply, stay on the lighter pattern.

## Setup

```typescript
import {
  SemiontClient,
  SemiontSession,
  HttpTransport,
  HttpContentTransport,
  InMemorySessionStorage,
  setStoredSession,
  type KnowledgeBase,
} from '@semiont/sdk';
import {
  accessToken,
  baseUrl,
  type AccessToken,
} from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

const apiUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
const apiUrlObj = new URL(apiUrl);

const kb: KnowledgeBase = {
  id: 'watcher',
  label: 'Long-running watcher',
  protocol: apiUrlObj.protocol.replace(':', '') as 'http' | 'https',
  host: apiUrlObj.hostname,
  port: Number(apiUrlObj.port || (apiUrlObj.protocol === 'https:' ? 443 : 80)),
  email: process.env.SEMIONT_USER_EMAIL ?? 'script@local',
};

// 1. Storage. InMemorySessionStorage is fine for daemons that re-authenticate
// at startup; for scripts that should survive process restarts, write a
// filesystem adapter (skeleton below).
const storage = new InMemorySessionStorage();

// 2. Seed the storage with the initial token before the session reads it.
setStoredSession(storage, kb.id, {
  access: process.env.SEMIONT_ACCESS_TOKEN ?? '',
  refresh: process.env.SEMIONT_REFRESH_TOKEN ?? '',
});

// 3. Shared token observable. Same instance flows into both the transport
// (which reads it for request headers) and the session (which writes
// refreshed tokens to it).
const token$ = new BehaviorSubject<AccessToken | null>(
  accessToken(process.env.SEMIONT_ACCESS_TOKEN ?? ''),
);

// 4. Build the transport stack and the client.
const transport = new HttpTransport({ baseUrl: baseUrl(apiUrl), token$ });
const semiont = new SemiontClient(transport, new HttpContentTransport(transport));

// 5. Construct the session — it owns refresh + validation around the client.
const session = new SemiontSession({
  kb,
  storage,
  client: semiont,
  token$,
  refresh: async () => {
    const refreshToken = process.env.SEMIONT_REFRESH_TOKEN;
    if (!refreshToken) return null;
    try {
      const response = await semiont.auth.refresh(refreshToken);
      return response.access_token;   // OpenAPI shape: snake_case
    } catch {
      return null;   // null tells the session refresh is impossible; it surfaces via onAuthFailed
    }
  },
  // Optional `validate` callback runs once on `ready` and populates
  // `session.user$`. Omit for service-principal sessions (workers,
  // scheduled jobs) that have no user record. User-attended scripts
  // typically set it to `async () => semiont.auth.me()` — adjust the
  // return shape to `UserInfo` (`components['schemas']['UserResponse']`)
  // if TS complains about the cast.
  onAuthFailed: (msg) => console.error('auth failed, terminal:', msg),
  onError: (err) => console.error('session error:', err.code, err.message),
});

await session.ready;   // resolves after the initial validate round-trip
```

## Filesystem-backed SessionStorage (sketch)

`@semiont/sdk` ships `InMemorySessionStorage` only — browser-backed lives in `@semiont/react-ui`. For a long-running CLI/daemon that should persist tokens across restarts, implement the small `SessionStorage` interface against a JSON file:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionStorage } from '@semiont/sdk';

class FileSessionStorage implements SessionStorage {
  private map = new Map<string, string>();
  constructor(private readonly path: string) {
    try { this.map = new Map(Object.entries(JSON.parse(readFileSync(path, 'utf-8')))); } catch {}
  }
  get(key: string) { return this.map.get(key) ?? null; }
  set(key: string, value: string) { this.map.set(key, value); this.flush(); }
  delete(key: string) { this.map.delete(key); this.flush(); }
  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
  }
}

const storage = new FileSessionStorage(`${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/semiont/watcher.json`);
```

The optional `subscribe` method is for cross-process change notification (`fs.watch` + parse). Omit unless multiple processes share the same file.

## Subscribing to bus events

`session.subscribe(channel, handler)` returns an unsubscribe disposer. Wire whatever channel the watcher cares about:

```typescript
const unsubAdded = session.subscribe('mark:added', (event) => {
  if (event.motivation === 'linking') {
    void handleNewLinkingAnnotation(event.resourceId, event.annotationId);
  }
});

const unsubProgress = session.subscribe('job:report-progress', (event) => {
  console.log(`job ${event.jobId}: ${event.percentage}%`);
});
```

Channels are typed: TypeScript knows `event` is a `MarkAddedEvent` for `'mark:added'`. The full channel set is in `@semiont/core`'s `EventMap`.

## Worked example — react to new linking annotations

A daemon that watches for fresh `linking` annotations and runs the wiki pipeline (see the `semiont-wiki` skill) on each one as it appears.

```typescript
async function handleNewLinkingAnnotation(resourceIdStr: string, annotationIdStr: string) {
  // ... gather → match → bind | yield, as in semiont-wiki.
  // The session's `semiont` client is what you call here:
  //   await semiont.gather.annotation(...)
  //   await semiont.match.search(...)
  //   await semiont.bind.body(...)
  //   await semiont.yield.fromAnnotation(...)
}

const unsubAdded = session.subscribe('mark:added', (event) => {
  if (event.motivation !== 'linking') return;
  // Don't await inside the handler — fire-and-forget, log on rejection.
  void handleNewLinkingAnnotation(event.resourceId, event.annotationId)
    .catch((err) => console.error('pipeline failed:', err));
});

console.log('Watching for new linking annotations. Ctrl-C to exit.');
```

## Graceful shutdown

```typescript
async function shutdown() {
  unsubAdded();
  await session.dispose();   // cancels refresh timer, completes observables, disposes the client
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the event loop alive — the session's bus subscription does that as long
// as the transport's SSE connection is open, but if your watcher does nothing
// else you may also want a heartbeat.
```

## Guidance for the AI assistant

- **Reach for `SemiontSession` only when the script runs longer than one token's lifetime.** For one-shot scripts (annotate a doc, run a pipeline once), the lighter `SemiontClient` pattern in the `semiont-highlight` / `semiont-wiki` skills is correct. Don't add the session's complexity if it isn't earning anything.
- **The `refresh` callback is the load-bearing part.** Make sure it can return a token without the current one — typically by having a refresh-token cached in storage or env, and calling `semiont.auth.refresh(refreshToken)`. If the callback returns `null`, the session is terminally unauthenticated and `onAuthFailed` fires.
- **`token$` must be the same `BehaviorSubject` instance** passed to both the transport and the session. The session writes refreshed tokens; the transport reads them. If they're separate observables, refresh appears to succeed but the next request still uses the dead token.
- **Validate is optional.** Service-principal scripts (workers, scheduled jobs) usually omit it — they have a token but no associated user record. User-attended scripts use `semiont.auth.me()` to populate `user$`.
- **Storage choice depends on restart behavior.** `InMemorySessionStorage` is fine if the script re-authenticates from env every startup. Persist via filesystem only if you want token state to survive restarts.
- **Subscriptions are typed.** Use `session.subscribe(channel, handler)` for arbitrary channels; for verb-specific operations, prefer the namespace methods (`semiont.mark.assist(...)` etc.) — they handle SSE streaming, timeout, and progress tracking internally.
- **Always dispose on shutdown.** `session.dispose()` cancels the proactive-refresh timer and disposes the client; without it, the SSE connection holds the event loop open.
