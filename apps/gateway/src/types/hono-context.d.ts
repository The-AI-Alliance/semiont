/**
 * Hono Context Variable Type Declarations
 *
 * Extends Hono's ContextVariableMap to include custom context variables
 * used throughout the application.
 */

import 'hono';
import type { Principal } from '../identity/principal';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * The authenticated caller, set by authMiddleware from the token's claims.
     *
     * The attribution chain lives here and nowhere else. It used to be
     * accompanied by a `principalDid` carrying `principal.did` a second time,
     * which meant a consumer could read the authority without ever seeing that
     * an `actor` or a `client` stood behind it. One shape, read one way.
     */
    principal: Principal;

    /**
     * Validated request body set by validateRequestBody middleware
     * Type should be cast to specific schema type in route handlers
     */
    validatedBody: unknown;
  }
}
