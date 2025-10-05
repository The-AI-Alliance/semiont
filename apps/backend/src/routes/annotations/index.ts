// Main annotations router that combines all sub-routers
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { crudRouter } from './crud';
import { operationsRouter } from './operations';
import { createAnnotationRouter } from './shared';
import { registerGetAnnotationHistory } from './routes/history';

// Create main annotations router
export const annotationsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Mount all sub-routers
// IMPORTANT: operationsRouter must come BEFORE crudRouter so that specific routes
// like /api/annotations/{id}/generate-document-stream are registered before the
// catch-all /api/annotations/{id} route
annotationsRouter.route('/', operationsRouter); // operationsRouter already includes generate-document-stream
annotationsRouter.route('/', crudRouter);

// Register annotation history endpoint
const historyRouter = createAnnotationRouter();
registerGetAnnotationHistory(historyRouter);
annotationsRouter.route('/', historyRouter);