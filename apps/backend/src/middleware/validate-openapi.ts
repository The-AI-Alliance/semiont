/**
 * Hono middleware for validating requests against OpenAPI schemas
 *
 * This middleware validates request bodies, query parameters, and path parameters
 * against schemas defined in the OpenAPI specification.
 */

import { type Context, type Next, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateSchema } from '../utils/openapi-validator';
import { getLogger } from '../logger';

const logger = getLogger().child({ component: 'validate-openapi' });

/**
 * Validate request body against an OpenAPI schema
 *
 * @param schemaName - Name of the schema in components/schemas
 * @returns Hono middleware function
 *
 * @example
 * router.post('/api/annotations',
 *   validateRequestBody('CreateAnnotationRequest'),
 *   async (c) => {
 *     const body = await c.req.json(); // Already validated
 *     // ... handler logic
 *   }
 * );
 */
export function validateRequestBody(schemaName: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    let body: unknown;

    try {
      body = await c.req.json();
    } catch (error) {
      throw new HTTPException(400, {
        message: 'Invalid JSON in request body',
      });
    }

    const { valid, errors, errorMessage } = validateSchema(schemaName, body);

    if (!valid) {
      logger.warn('Request body validation failed', {
        schemaName,
        errorMessage,
        errors
      });
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

/**
 * Validate query parameters against an OpenAPI schema
 *
 * @param schemaName - Name of the schema in components/schemas
 * @returns Hono middleware function
 */
export function validateQuery(schemaName: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const query = c.req.query();

    const { valid, errors, errorMessage } = validateSchema(schemaName, query);

    if (!valid) {
      logger.warn('Query params validation failed', {
        schemaName,
        errorMessage,
        errors
      });
      throw new HTTPException(400, {
        message: errorMessage || 'Query validation failed',
        cause: errors,
      });
    }

    c.set('validatedQuery', query);

    await next();
  };
}

/**
 * Validate path parameters against an OpenAPI schema
 *
 * @param schemaName - Name of the schema in components/schemas
 * @returns Hono middleware function
 */
export function validateParams(schemaName: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const params = c.req.param();

    const { valid, errors, errorMessage } = validateSchema(schemaName, params);

    if (!valid) {
      logger.warn('Path params validation failed', {
        schemaName,
        errorMessage,
        errors
      });
      throw new HTTPException(400, {
        message: errorMessage || 'Path parameter validation failed',
        cause: errors,
      });
    }

    c.set('validatedParams', params);

    await next();
  };
}

/**
 * Generic validation middleware that can validate any part of the request
 *
 * @param target - What to validate ('body', 'query', or 'params')
 * @param schemaName - Name of the schema in components/schemas
 * @returns Hono middleware function
 */
export function validate(
  target: 'body' | 'query' | 'params',
  schemaName: string
): MiddlewareHandler {
  switch (target) {
    case 'body':
      return validateRequestBody(schemaName);
    case 'query':
      return validateQuery(schemaName);
    case 'params':
      return validateParams(schemaName);
  }
}
