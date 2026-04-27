/**
 * @semiont/sdk
 *
 * The Semiont SDK — `SemiontClient`, the verb-oriented namespaces, the
 * per-tab session layer, every view-model, and the supporting helpers
 * (`bus-request`, `cache`).
 *
 * Transport-agnostic: `SemiontClient` consumes the `ITransport` contract
 * defined in `@semiont/core`. The HTTP adapters (`HttpTransport`,
 * `HttpContentTransport`) are re-exported from here for convenience —
 * non-HTTP transports (e.g. `LocalTransport` from `@semiont/make-meaning`)
 * are wired by the caller.
 *
 * ```ts
 * import { SemiontClient, HttpTransport, HttpContentTransport } from '@semiont/sdk';
 * import { baseUrl } from '@semiont/core';
 *
 * const transport = new HttpTransport({ baseUrl: baseUrl('https://kb.example/') });
 * const client = new SemiontClient(transport, new HttpContentTransport(transport));
 * ```
 */

// SemiontClient + the convenience HTTP-adapter re-exports.
export * from './client';

// Thenable Observable subclasses — let scripts `await` namespace-method
// results directly without `lastValueFrom`/`firstValueFrom` wrappers.
export { StreamObservable, CacheObservable } from './awaitable';

// Bus-request helper + cache primitive.
export { busRequest, BusRequestError, type BusRequestPrimitive } from './bus-request';
export { createCache, type Cache } from './cache';

// Verb-oriented namespace API.
export { BrowseNamespace } from './namespaces/browse';
export { MarkNamespace } from './namespaces/mark';
export { BindNamespace } from './namespaces/bind';
export { GatherNamespace } from './namespaces/gather';
export { MatchNamespace } from './namespaces/match';
export { YieldNamespace } from './namespaces/yield';
export { BeckonNamespace } from './namespaces/beckon';
export { JobNamespace } from './namespaces/job';
export { AuthNamespace } from './namespaces/auth';
export { AdminNamespace } from './namespaces/admin';
export type * from './namespaces/types';

// Re-exports from @semiont/core for one-import convenience. The principled
// boundary still holds — sdk depends on core, never the reverse — but most
// consumers don't care about the layering and importing branded IDs from
// the same package as `SemiontClient` is the ergonomic default.
export type {
  Logger,
  // Branded ID + URL + token types
  AccessToken,
  AnnotationId,
  BaseUrl,
  RefreshToken,
  ResourceId,
  UserId,
  // Verb / shape types
  Annotation,
  BodyItem,
  BodyOperation,
  EntityType,
  EventMap,
  GatheredContext,
  Motivation,
  ResourceDescriptor,
  // Transport contracts
  ConnectionState,
  IContentTransport,
  ITransport,
} from '@semiont/core';
export {
  // Brand-cast functions
  accessToken,
  annotationId,
  baseUrl,
  entityType,
  refreshToken,
  resourceId,
  userId,
} from '@semiont/core';

// Session layer — per-KB sessions, app-level browser, storage adapter,
// error surface, notify module for out-of-React callers.
export { SemiontSession, type SemiontSessionConfig, type UserInfo } from './session/semiont-session';
export { SemiontBrowser, type SemiontBrowserConfig } from './session/semiont-browser';
export { FrontendSessionSignals } from './session/frontend-session-signals';
export { SemiontError, type SemiontErrorCode } from './session/errors';
export { getBrowser, type GetBrowserOptions } from './session/registry';
export {
  type SessionStorage,
  InMemorySessionStorage,
} from './session/session-storage';
export {
  type KnowledgeBase,
  type NewKnowledgeBase,
  type KbSessionStatus,
} from './session/knowledge-base';
export { type OpenResource } from './session/open-resource';
export {
  defaultProtocol,
  isValidHostname,
  kbBackendUrl,
  setStoredSession,
  type StoredSession,
} from './session/storage';
export { notifySessionExpired, notifyPermissionDenied } from './session/notify';

// View models (MVVM layer)
export * from './view-models';

// RxJS bridges — re-exported so consumers can unwrap our Observables to
// Promises without a separate `import { firstValueFrom } from 'rxjs'`.
// `mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`
// all return Observables that consumers typically `lastValueFrom` to await
// the final value, or `firstValueFrom` to grab the first non-undefined emit.
export { firstValueFrom, lastValueFrom } from 'rxjs';
