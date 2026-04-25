/**
 * @semiont/api-client
 *
 * HTTP client and utilities for the Semiont API
 *
 * This package provides:
 * - A SemiontClient class for making API requests
 * - SSE streaming client
 * - Utilities for working with annotations and text
 *
 * For OpenAPI types and branded types, import from @semiont/core:
 * ```typescript
 * import type { components } from '@semiont/core';
 * import { resourceUri, accessToken } from '@semiont/core';
 * import { SemiontClient } from '@semiont/api-client';
 *
 * const client = new SemiontClient({ baseUrl: baseUrl('http://localhost:4000') });
 * const token = accessToken('your-token');
 * const rUri = resourceUri('http://localhost:4000/resources/doc-123');
 * ```
 */

// Export clients
export * from './client';
export { busRequest, BusRequestError, type BusRequestPrimitive } from './bus-request';
export { createCache, type Cache } from './cache';

// HTTP-specific transport implementations. The shared transport contract
// (`ITransport`, `IContentTransport`, `BRIDGED_CHANNELS`, response types,
// `ConnectionState`) lives in `@semiont/core`; consumers import from there.
export { HttpTransport, type HttpTransportConfig } from './transport/http-transport';
export { HttpContentTransport } from './transport/http-content-transport';


// Verb-oriented namespace API
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

// Logger interface for observability (re-export from core)
export type { Logger } from '@semiont/core';

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
