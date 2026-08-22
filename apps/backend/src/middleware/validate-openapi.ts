/**
 * Hono middleware for validating requests against OpenAPI schemas
 *
 * Validates request bodies against the validators generated from the OpenAPI
 * spec (`@semiont/core/openapi`). Query- and path-parameter variants existed
 * here with no callers and were deleted rather than carried through the
 * validator promotion.
 */

import { type Context, type Next, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ValidateFunction } from 'ajv';
import { formatErrors } from '@semiont/core/openapi';
import { getLogger } from '../logger';

// Lazy initialization to avoid calling getLogger() at module load time
const getMiddlewareLogger = () => getLogger().child({ component: 'validate-openapi' });

/**
 * Validate request body against an OpenAPI schema
 *
 * @param validate - A generated validator from `@semiont/core/openapi`
 * @returns Hono middleware function
 *
 * @example
 * router.post('/api/annotations',
 *   validateRequestBody(validators.CreateAnnotationRequest),
 *   async (c) => {
 *     const body = await c.req.json(); // Already validated
 *     // ... handler logic
 *   }
 * );
 */
export function validateRequestBody(validate: ValidateFunction): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    let body: unknown;

    try {
      body = await c.req.json();
    } catch (error) {
      throw new HTTPException(400, {
        message: 'Invalid JSON in request body',
      });
    }

    if (!validate(body)) {
      const errors = validate.errors;
      const errorMessage = formatErrors(errors);
      getMiddlewareLogger().warn('Request body validation failed', { errorMessage, errors });
      throw new HTTPException(400, {
        message: errorMessage || 'Request validation failed',
        cause: errors,
      });
    }

    // Store validated body in context for handler to retrieve
    c.set('validatedBody', body);

    await next();
  };
}
