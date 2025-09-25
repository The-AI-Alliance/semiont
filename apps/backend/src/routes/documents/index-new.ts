// Main documents router that combines all individual route files
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';

// Import individual route registration functions
import { registerCreateDocument } from './routes/create';
import { registerGetDocument } from './routes/get';
import { registerListDocuments } from './routes/list';
import { registerUpdateDocument } from './routes/update';
import { registerDeleteDocument } from './routes/delete';
import { registerSearchDocuments } from './routes/search';
import { registerGetDocumentContent } from './routes/get-content';

// Create main documents router
export const documentsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware
documentsRouter.use('/api/documents/*', authMiddleware);

// Register all routes
registerCreateDocument(documentsRouter);
registerGetDocument(documentsRouter);
registerListDocuments(documentsRouter);
registerUpdateDocument(documentsRouter);
registerDeleteDocument(documentsRouter);
registerSearchDocuments(documentsRouter);
registerGetDocumentContent(documentsRouter);

// TODO: Add remaining routes from the original files