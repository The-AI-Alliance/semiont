/**
 * Hono Context Variable Type Declarations
 *
 * Extends Hono's ContextVariableMap to include custom context variables
 * used throughout the application.
 */

import 'hono';
import type { Principal } from '../identity/principal';
import type { ServiceAccountCredential } from '@semiont/core';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * The authenticated caller, set by authMiddleware from the token's claims.
     *
     * The attribution chain lives here and nowhere else. A second variable
     * carrying `principal.did` would let a consumer read the authority without
     * ever seeing that an `actor` or a `client` stands behind it. One shape,
     * read one way.
     */
    principal: Principal;

    /**
     * How to get this process's own account at the issuer, for the routes that
     * dial the Archivist. A resolver, not a value: a knowledge base with no
     * `[identity]` section is supported, and such a gateway must still boot —
     * it simply never calls this.
     */
    archivistCredential: () => ServiceAccountCredential;

    /**
     * Validated request body set by validateRequestBody middleware
     * Type should be cast to specific schema type in route handlers
     */
    validatedBody: unknown;
  }
}
