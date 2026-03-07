/**
 * Annotations Router
 *
 * This router now ONLY handles the W3C content negotiation endpoint for flat annotation URIs.
 * All CRUD operations have been moved to nested paths under /resources/{resourceId}/annotations/...
 *
 * Endpoints:
 * - GET /annotations/{id} - W3C content negotiation for annotation URIs
 */

import { Hono } from 'hono';
import { User } from '@prisma/client';
import { createAnnotationRouter } from './shared';
import { registerGetAnnotationUri } from './routes/get-uri';
import { operationsRouter } from './operations';

// Create main annotations router
export const annotationsRouter = new Hono<{ Variables: { user: User } }>();

// Register W3C content negotiation endpoint for annotation URIs
const uriRouter = createAnnotationRouter();
registerGetAnnotationUri(uriRouter);
annotationsRouter.route('/', uriRouter);

// Register annotation operations (yield-resource-stream, etc.)
annotationsRouter.route('/', operationsRouter);