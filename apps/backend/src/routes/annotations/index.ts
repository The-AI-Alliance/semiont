// Main annotations router that combines all sub-routers
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { crudRouter } from './crud';
import { operationsRouter } from './operations';
import { createAnnotationRouter } from './shared';
import { registerGetAnnotationHistory } from './routes/history';
import { registerGetAnnotationUri } from './routes/get-uri';

// Create main annotations router
export const annotationsRouter = new Hono<{ Variables: { user: User } }>();

// Mount all sub-routers
// IMPORTANT: operationsRouter must come BEFORE crudRouter so that specific routes
// like /api/annotations/{id}/generate-resource-stream are registered before the
// catch-all /api/annotations/{id} route
annotationsRouter.route('/', operationsRouter); // operationsRouter already includes generate-resource-stream
annotationsRouter.route('/', crudRouter);

// Register annotation history endpoint
const historyRouter = createAnnotationRouter();
registerGetAnnotationHistory(historyRouter);
annotationsRouter.route('/', historyRouter);

// Register W3C content negotiation endpoint for annotation URIs
const uriRouter = createAnnotationRouter();
registerGetAnnotationUri(uriRouter);
annotationsRouter.route('/', uriRouter);