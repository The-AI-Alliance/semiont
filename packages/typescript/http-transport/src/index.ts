/**
 * @semiont/http-transport
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
 * by hand, as the MCP server does.
 */

export {
  HttpTransport,
  currentUserOf,
  type HttpTransportConfig,
  type TokenRefresher,
} from './transport/http-transport';
export { APIError } from './transport/api-error';
export { agentToken, type AgentSignIn } from './transport/agent-token';

export { HttpContentTransport } from './transport/http-content-transport';
