/**
 * @semiont/api-client
 *
 * HTTP-specific transport adapters for the Semiont SDK. The dev-facing
 * surface (`SemiontClient`, namespaces, session, state units, helpers)
 * lives in `@semiont/sdk`. The shared transport contract
 * (`ITransport`, `IContentTransport`, `BRIDGED_CHANNELS`,
 * `ConnectionState`, response types) lives in `@semiont/core`.
 *
 * Most consumers do not import from this package directly — `@semiont/sdk`
 * re-exports the HTTP adapters so a typical app does:
 *
 * ```ts
 * import { SemiontClient, HttpTransport, HttpContentTransport } from '@semiont/sdk';
 * ```
 *
 * Direct imports are appropriate when constructing the transport stack
 * by hand (CLI factories, MCP entrypoints, worker pools).
 */

export {
  HttpTransport,
  type HttpTransportConfig,
  type TokenRefresher,
  APIError,
} from './transport/http-transport';

export { HttpContentTransport } from './transport/http-content-transport';

// `actor-state-unit` is HttpTransport's SSE machinery. Exposed for domain-side
// worker adapters (`createJobClaimAdapter` in `@semiont/jobs`,
// `createSmelterActorStateUnit` in `@semiont/make-meaning`) that build
// worker-flavored variants on top of it. Application code should not
// import these directly.
export {
  createActorStateUnit,
  type ActorStateUnit,
  type BusEvent,
  type ActorStateUnitOptions,
  DEGRADED_THRESHOLD_MS,
} from './transport/actor-state-unit';
