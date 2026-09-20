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
     */
    principal: Principal;

    /** That principal's DID — the identity every consumer downstream keys on. */
    principalDid: string;

    /**
     * Validated request body set by validateRequestBody middleware
     * Type should be cast to specific schema type in route handlers
     */
    validatedBody: unknown;
  }
}
