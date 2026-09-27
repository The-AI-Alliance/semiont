/**
 * Hono Context Variable Type Declarations
 *
 * Extends Hono's ContextVariableMap to include custom context variables
 * used throughout the application.
 */

import 'hono';
import type { Principal } from '../identity/principal';
import type { ArchivistAccess } from '../lib/archivist';

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

    /** Where the Archivist is and the gateway's own account to reach it with, for the routes that proxy to it. */
    archivist: ArchivistAccess;
  }
}
