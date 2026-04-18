# @semiont/api-client

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+api-client%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=api-client)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=api-client)
[![npm version](https://img.shields.io/npm/v/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![License](https://img.shields.io/npm/l/@semiont/api-client.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

TypeScript SDK for [Semiont](https://github.com/The-AI-Alliance/semiont) — a knowledge management system for semantic annotations, AI-powered analysis, and collaborative document understanding.

The api-client is a transparent proxy to `@semiont/make-meaning`. The browser writes code as though it has direct access to the knowledge system. HTTP, auth, SSE, and caching are internal concerns.

## The 7 Verbs

The API is organized by the domain's verbs — the same verbs that organize the EventBus protocol, the documentation, and the backend actors:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const semiont = new SemiontApiClient({ baseUrl, eventBus, token$ });

// Browse — reads from materialized views
const resource = semiont.browse.resource(resourceId);       // Observable
const annotations = semiont.browse.annotations(resourceId); // Observable
const content = await semiont.browse.resourceContent(rid);   // Promise

// Mark — annotation CRUD + AI assist
await semiont.mark.annotation(resourceId, input);
await semiont.mark.delete(resourceId, annotationId);
semiont.mark.assist(resourceId, 'linking', options);         // Observable (progress)

// Bind — reference linking
await semiont.bind.body(resourceId, annotationId, operations);

// Gather — LLM context assembly
semiont.gather.annotation(annotationId, resourceId);         // Observable (progress → context)

// Match — semantic search
semiont.match.search(resourceId, referenceId, context);      // Observable (results)

// Yield — resource creation + AI generation
await semiont.yield.resource(data);
semiont.yield.fromAnnotation(resourceId, annotationId, opts); // Observable (progress)

// Beckon — attention coordination
semiont.beckon.attention(annotationId, resourceId);           // void (ephemeral)

// + Job, Auth, Admin namespaces
```

## Return Type Conventions

- **Browse live queries** → `Observable` (bus-gateway driven, cached in BehaviorSubject)
- **Browse one-shot reads** → `Promise` (fetch once, no cache)
- **Commands** (mark, bind, yield.resource) → `Promise` (fire-and-forget)
- **Long-running ops** (gather, match, yield.fromAnnotation, mark.assist) → `Observable` (progress + result)
- **Ephemeral signals** (beckon) → `void`

## Auth is Internal

The client takes an observable `token$` at construction. All namespace
calls and the bus SSE connection read the current value. Update by
calling `.next(newToken)` on the BehaviorSubject — the client auto-starts
the bus actor the first time the token transitions from null to a real
value, and the actor reconnects with the new token after refresh.

```typescript
import { BehaviorSubject } from 'rxjs';

const token$ = new BehaviorSubject<AccessToken | null>(accessToken(token));

const semiont = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
  eventBus: new EventBus(),
  token$,
});

// No auth on individual calls
const annotations = semiont.browse.annotations(resourceId);
await semiont.mark.annotation(resourceId, input);
await semiont.bind.body(resourceId, annotationId, operations);

// Token rotation — e.g. after refresh
token$.next(accessToken(newToken));
```

Omit `token$` entirely for unauthenticated usage (public endpoints only).
The bus actor will not connect until a non-null token is available.

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
