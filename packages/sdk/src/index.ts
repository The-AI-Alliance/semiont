/**
 * @semiont/sdk
 *
 * The Semiont SDK — `SemiontClient`, the verb-oriented namespaces, the
 * per-tab session layer, the flow state machines and worker adapters,
 * and the supporting helpers (`bus-request`, `cache`).
 *
 * Transport-agnostic: `SemiontClient` consumes the `ITransport` /
 * `IContentTransport` contracts from `@semiont/core`. The HTTP adapters
 * (`HttpTransport`, `HttpContentTransport`) are re-exported here for
 * convenience so the common case is a single import; non-HTTP transports
 * (e.g. `LocalTransport` from `@semiont/make-meaning`) are constructed
 * by the caller from their own package.
 *
 * Transport-specific error classes (`APIError` from `@semiont/api-client`)
 * are NOT re-exported. Catch on `SemiontError` (exported below) and route
 * on `err.code`; reach for the transport-specific class only when you're
 * already in HTTP-aware code and import it from `@semiont/api-client`
 * directly.
 *
 * ```ts
 * import { SemiontClient, HttpTransport, HttpContentTransport } from '@semiont/sdk';
 * import { baseUrl } from '@semiont/core';
 *
 * const transport = new HttpTransport({ baseUrl: baseUrl('https://kb.example/') });
 * // HttpTransport implements both ITransport and IBackendOperations;
 * // passing it as the third arg wires `client.auth` and `client.admin`.
 * const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
 * ```
 */

// SemiontClient + the convenience HTTP-adapter re-exports.
export * from './client';

// Thenable Observable subclasses — let scripts `await` namespace-method
// results directly without `lastValueFrom`/`firstValueFrom` wrappers.
export { StreamObservable, CacheObservable, UploadObservable, type UploadProgress } from './awaitable';

// Bus-request helper.
export {
  busRequest,
  BusRequestError,
  type BusRequestErrorCode,
  type BusRequestPrimitive,
} from './bus-request';

// Verb-oriented namespace API. Frame is the schema-layer flow's surface;
// the others are content-layer flows + job/auth/admin.
export { FrameNamespace } from './namespaces/frame';
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
  TagCategory,
  TagSchema,
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
  // Unified error base — every Semiont-thrown error extends this.
  SemiontError,
} from '@semiont/core';

// Session layer — per-KB sessions, app-level browser, storage adapter,
// error surface, notify module for out-of-React callers.
export { SemiontSession, type SemiontSessionConfig, type UserInfo } from './session/semiont-session';
export { SemiontBrowser, type SemiontBrowserConfig } from './session/semiont-browser';
export type { SessionFactory, SessionFactoryOptions } from './session/session-factory';
export { createHttpSessionFactory } from './session/http-session-factory';
export { SessionSignals } from './session/session-signals';
export { SemiontSessionError, type SemiontSessionErrorCode } from './session/errors';
export { getBrowser, type GetBrowserOptions } from './session/registry';
export {
  type SessionStorage,
  InMemorySessionStorage,
} from './session/session-storage';
export {
  type KnowledgeBase,
  type KbEndpoint,
  type HttpEndpoint,
  type LocalEndpoint,
  type NewKnowledgeBase,
  type KbSessionStatus,
  httpKb,
} from './session/knowledge-base';
export { type OpenResource } from './session/open-resource';
export {
  defaultProtocol,
  isValidHostname,
  kbBackendUrl,
  setStoredSession,
  type StoredSession,
} from './session/storage';

// State units — flow state machines, worker adapters, RxJS substrate.
// None presume a UI: they're consumed by browser apps, terminals,
// daemons, and AI agents alike. See packages/sdk/docs/STATE-UNITS.md.
export * from './state';

// RxJS bridges — re-exported so consumers can unwrap our Observables to
// Promises without a separate `import { firstValueFrom } from 'rxjs'`.
// `mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`
// all return Observables that consumers typically `lastValueFrom` to await
// the final value, or `firstValueFrom` to grab the first non-undefined emit.
export { firstValueFrom, lastValueFrom } from 'rxjs';
