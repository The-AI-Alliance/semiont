# @semiont/api-client

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+api-client%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=api-client)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=api-client)
[![npm version](https://img.shields.io/npm/v/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![License](https://img.shields.io/npm/l/@semiont/api-client.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

TypeScript SDK for [Semiont](https://github.com/The-AI-Alliance/semiont) — a knowledge management system for semantic annotations, AI-powered analysis, and collaborative document understanding.

The api-client is a transparent proxy to `@semiont/make-meaning`. Callers write code as though they have direct access to the knowledge system. HTTP, auth, SSE, caching, and cross-tab session sync are internal concerns.

## Getting a Session

`SemiontSession` is the canonical entry point. It owns a `SemiontApiClient`, manages the access-token lifecycle (initial token, refresh, expiry), and synchronizes session state across tabs or processes. Every Semiont actor — frontend, CLI, MCP, workers, smelter — uses the same `SemiontSession` primitive.

```typescript
import {
  SemiontSession,
  InMemorySessionStorage,
  setStoredSession,
  type KnowledgeBase,
} from '@semiont/api-client';

const kb: KnowledgeBase = {
  id: 'local',
  label: 'Local Backend',
  protocol: 'http',
  host: 'localhost',
  port: 4000,
  email: 'me@example.com',
};

const storage = new InMemorySessionStorage();
setStoredSession(storage, kb.id, { access: initialAccessToken, refresh: initialRefreshToken });

const session = new SemiontSession({
  kb,
  storage,
  refresh: async () => {
    // Re-authenticate when the stored token expires or a 401 arrives.
    // Frontend: POST /api/tokens/refresh with the stored refresh token.
    // Worker/service: POST /api/tokens/worker with a shared secret.
    // CLI/MCP: read the long-lived refresh token from filesystem storage.
    // Return the new access token, or null if recovery is impossible.
    return newAccessToken;
  },
});
await session.ready;
```

Three required pieces:

- **`kb`** — a `KnowledgeBase` descriptor identifying which backend to talk to (protocol, host, port, and a stable `id` used as the session-storage key).
- **`storage`** — a `SessionStorage` adapter: `InMemorySessionStorage` for scripts and tests, `WebBrowserStorage` in a browser, filesystem storage for CLI/MCP.
- **`refresh`** — a closure that re-authenticates however your actor does. The session calls it on 401 or proactive refresh; the details of the token exchange are up to you.

## The 7 Verbs

All domain calls go through `session.client`. Namespaces mirror the bus-protocol verbs and the backend actors:

```typescript
// Browse — reads from materialized views; UI signals
const resource = session.client.browse.resource(resourceId);         // Observable
const annotations = session.client.browse.annotations(resourceId);   // Observable
const content = await session.client.browse.resourceContent(rid);     // Promise
session.client.browse.click(annotationId, motivation);                // void (UI signal)
session.client.browse.navigateReference(resourceId);                  // void (UI signal)

// Mark — annotation CRUD + AI assist; pending-annotation flow; toolbar state
await session.client.mark.annotation(resourceId, input);
await session.client.mark.delete(resourceId, annotationId);
await session.client.mark.archive(resourceId);
await session.client.mark.unarchive(resourceId);
session.client.mark.assist(resourceId, 'linking', options);           // Observable (progress)

session.client.mark.request(selector, motivation);                    // UI: request a new annotation
session.client.mark.submit({ motivation, selector, body? });          // UI: submit pending annotation
session.client.mark.cancelPending();                                   // UI: cancel pending annotation
session.client.mark.requestAssist(motivation, options);               // UI: fire-and-forget assist trigger
session.client.mark.dismissProgress();                                 // UI: dismiss assist progress

session.client.mark.changeSelection(motivation | null);               // UI: toolbar selection state
session.client.mark.changeClick(action);                              // UI: toolbar click-mode state
session.client.mark.changeShape(shape);                               // UI: toolbar shape state
session.client.mark.toggleMode();                                      // UI: annotate-mode toggle

// Bind — reference linking
await session.client.bind.body(resourceId, annotationId, operations);
session.client.bind.initiate({ annotationId, resourceId, defaultTitle, entityTypes }); // UI signal

// Gather — LLM context assembly
session.client.gather.annotation(annotationId, resourceId);           // Observable (progress → context)

// Match — semantic search
session.client.match.search(resourceId, referenceId, context);        // Observable (results)
session.client.match.requestSearch({ correlationId, resourceId, referenceId, context, ... }); // fire-and-forget

// Yield — resource creation + AI generation
await session.client.yield.resource(data);
session.client.yield.fromAnnotation(resourceId, annotationId, opts);  // Observable (progress)
session.client.yield.clone();                                          // UI: clone-resource action

// Beckon — attention coordination
session.client.beckon.attention(annotationId, resourceId);            // void (ephemeral)
session.client.beckon.hover(annotationId);                            // void (UI signal; null on unhover)
session.client.beckon.sparkle(annotationId);                          // void (UI signal)

// Job
await session.client.job.status(jobId);
await session.client.job.cancel(jobId, type);
session.client.job.cancelRequest('annotation');                        // UI: cancel all jobs of a type

// + Auth, Admin namespaces
```

## Return Type Conventions

- **Browse live queries** → `Observable` (bus-gateway driven, cached in BehaviorSubject)
- **Browse one-shot reads** → `Promise` (fetch once, no cache)
- **Commands** (mark, bind, yield.resource) → `Promise` (fire-and-forget)
- **Long-running ops** (gather, match, yield.fromAnnotation, mark.assist) → `Observable` (progress + result)
- **UI signals** (beckon, `browse.click`, `browse.navigateReference`, `mark.request`) → `void` (fire-and-forget, local bus fan-out)

## Auth is Internal

The session owns the access-token lifecycle. Namespace calls read the current token, attach it to every HTTP and SSE request, and reconnect with a refreshed token automatically. You never pass a token to an individual call; when the session refreshes, in-flight streams resume via `Last-Event-ID` without losing events.

## Installation

```bash
npm install @semiont/api-client
```

**Prerequisites**: Semiont backend running. See [Running the Backend](../../apps/backend/README.md#quick-start).

## Documentation

- [Usage Guide](./docs/Usage.md) — authentication, resources, annotations, streaming
- [API Reference](./docs/API-Reference.md) — complete method documentation
- [Utilities Guide](./docs/Utilities.md) — text encoding, fuzzy anchoring, SVG utilities
- [Logging Guide](./docs/LOGGING.md) — logger setup and troubleshooting

## Key Features

- **Verb-oriented** — 7 domain namespaces mirror `@semiont/make-meaning`'s actor model
- **Type-safe** — OpenAPI types from `@semiont/core`, branded identifiers
- **Observable reads** — live-updating views via the bus gateway (single SSE connection)
- **Framework-agnostic** — pure TypeScript + RxJS, no React dependency

## License

Apache-2.0
