// Main selections router that combines all sub-routers
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { crudRouter } from './crud';
import { operationsRouter } from './operations';

// Create main selections router
export const selectionsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Mount all sub-routers
selectionsRouter.route('/', crudRouter);
selectionsRouter.route('/', operationsRouter);