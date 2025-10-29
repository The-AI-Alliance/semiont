// Main documents router that combines all individual route files
import { createDocumentRouter } from './shared';
import type { DocumentsRouterType } from './shared';

// Import registration functions for all routes
import { registerCreateDocument } from './routes/create';
import { registerGetDocumentUri } from './routes/get-uri';
import { registerListDocuments } from './routes/list';
import { registerUpdateDocument } from './routes/update';
import { registerSearchDocuments } from './routes/search';
import { registerCreateDocumentFromAnnotation } from './routes/create-from-annotation';
import { registerDetectAnnotationsStream } from './routes/detect-annotations-stream';
import { registerDetectEntities } from './routes/detect-entities';
import { registerGetDocumentLLMContext } from './routes/llm-context';
import { registerGetReferenceLLMContext } from './routes/reference-llm-context';
import { registerGetReferencedBy } from './routes/referenced-by';
import { registerDiscoverContext } from './routes/discover-context';
import { registerTokenRoutes } from './routes/token';
import { registerGetDocumentAnnotations } from './routes/get-annotations';
import { registerGetEvents } from './routes/events';
import { registerGetEventStream } from './routes/events-stream';

// Create main documents router
export const documentsRouter: DocumentsRouterType = createDocumentRouter();

// Register all routes
registerCreateDocument(documentsRouter);
registerListDocuments(documentsRouter);
registerSearchDocuments(documentsRouter);  // Must be before registerGetDocumentUri to avoid {id} matching "search"
registerGetDocumentUri(documentsRouter);  // W3C content negotiation for /documents/:id - handles both metadata and raw representations
registerUpdateDocument(documentsRouter);
registerCreateDocumentFromAnnotation(documentsRouter);
registerDetectAnnotationsStream(documentsRouter);
registerDetectEntities(documentsRouter);
registerGetDocumentLLMContext(documentsRouter);
registerGetReferenceLLMContext(documentsRouter);
registerGetReferencedBy(documentsRouter);
registerDiscoverContext(documentsRouter);
registerTokenRoutes(documentsRouter);
registerGetDocumentAnnotations(documentsRouter);
registerGetEvents(documentsRouter);
registerGetEventStream(documentsRouter);