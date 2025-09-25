// Main documents router that combines all individual route files
import { createDocumentRouter } from './shared';
import type { DocumentsRouterType } from './shared';

// Import registration functions for all routes
import { registerCreateDocument } from './routes/create';
import { registerGetDocument } from './routes/get';
import { registerListDocuments } from './routes/list';
import { registerUpdateDocument } from './routes/update';
import { registerDeleteDocument } from './routes/delete';
import { registerSearchDocuments } from './routes/search';
import { registerGetDocumentContent } from './routes/get-content';
import { registerCloneDocument } from './routes/clone';
import { registerGetDocumentByToken } from './routes/get-by-token';
import { registerCreateDocumentFromToken } from './routes/create-from-token';
import { registerCreateDocumentFromSelection } from './routes/create-from-selection';
import { registerDetectSelections } from './routes/detect-selections';
import { registerGetDocumentLLMContext } from './routes/llm-context';
import { registerGetReferenceLLMContext } from './routes/reference-llm-context';
import { registerGetReferencedBy } from './routes/referenced-by';
import { registerDiscoverContext } from './routes/discover-context';

// Create main documents router
export const documentsRouter: DocumentsRouterType = createDocumentRouter();

// Register all routes
registerCreateDocument(documentsRouter);
registerGetDocument(documentsRouter);
registerListDocuments(documentsRouter);
registerUpdateDocument(documentsRouter);
registerDeleteDocument(documentsRouter);
registerSearchDocuments(documentsRouter);
registerGetDocumentContent(documentsRouter);
registerCloneDocument(documentsRouter);
registerGetDocumentByToken(documentsRouter);
registerCreateDocumentFromToken(documentsRouter);
registerCreateDocumentFromSelection(documentsRouter);
registerDetectSelections(documentsRouter);
registerGetDocumentLLMContext(documentsRouter);
registerGetReferenceLLMContext(documentsRouter);
registerGetReferencedBy(documentsRouter);
registerDiscoverContext(documentsRouter);