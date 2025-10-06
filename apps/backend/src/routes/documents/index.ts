// Main documents router that combines all individual route files
import { createDocumentRouter } from './shared';
import type { DocumentsRouterType } from './shared';

// Import registration functions for all routes
import { registerCreateDocument } from './routes/create';
import { registerGetDocument } from './routes/get';
import { registerListDocuments } from './routes/list';
import { registerUpdateDocument } from './routes/update';
import { registerSearchDocuments } from './routes/search';
import { registerGetDocumentContent } from './routes/get-content';
import { registerCloneDocument } from './routes/clone';
import { registerCreateDocumentFromAnnotation } from './routes/create-from-annotation';
import { registerDetectAnnotations } from './routes/detect-annotations';
import { registerDetectAnnotationsStream } from './routes/detect-annotations-stream';
import { registerGetDocumentLLMContext } from './routes/llm-context';
import { registerGetReferenceLLMContext } from './routes/reference-llm-context';
import { registerGetReferencedBy } from './routes/referenced-by';
import { registerDiscoverContext } from './routes/discover-context';
import { registerTokenRoutes } from './routes/token';
import { registerDocumentHighlights } from './routes/highlights';
import { registerDocumentReferences } from './routes/references';
import { registerGetDocumentAnnotations } from './routes/get-annotations';
import { registerGetEvents } from './routes/events';
import { registerGetEventStream } from './routes/events-stream';

// Create main documents router
export const documentsRouter: DocumentsRouterType = createDocumentRouter();

// Register all routes
registerCreateDocument(documentsRouter);
registerListDocuments(documentsRouter);
registerSearchDocuments(documentsRouter);  // Must be before registerGetDocument to avoid {id} matching "search"
registerGetDocument(documentsRouter);
registerUpdateDocument(documentsRouter);
registerGetDocumentContent(documentsRouter);
registerCloneDocument(documentsRouter);
registerCreateDocumentFromAnnotation(documentsRouter);
registerDetectAnnotations(documentsRouter);
registerDetectAnnotationsStream(documentsRouter);
registerGetDocumentLLMContext(documentsRouter);
registerGetReferenceLLMContext(documentsRouter);
registerGetReferencedBy(documentsRouter);
registerDiscoverContext(documentsRouter);
registerTokenRoutes(documentsRouter);
registerDocumentHighlights(documentsRouter);
registerDocumentReferences(documentsRouter);
registerGetDocumentAnnotations(documentsRouter);
registerGetEvents(documentsRouter);
registerGetEventStream(documentsRouter);