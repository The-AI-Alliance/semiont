// Main selections router that combines all sub-routers
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { crudRouter } from './crud';

// Create main selections router
export const selectionsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Mount all sub-routers
selectionsRouter.route('/', crudRouter);

// TODO: Migrate remaining routes from selections.ts to appropriate sub-modules