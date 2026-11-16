/**
 * Hono Context Variable Type Declarations
 *
 * Extends Hono's ContextVariableMap to include custom context variables
 * used throughout the application.
 */

import 'hono';
import type { User } from '@prisma/client';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * Authenticated user object set by authMiddleware
     */
    user: User;

    /**
     * Validated request body set by validateRequestBody middleware
     * Type should be cast to specific schema type in route handlers
     */
    validatedBody: unknown;
  }
}
