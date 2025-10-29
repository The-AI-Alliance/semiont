// Main resources router that combines all individual route files
import { createResourceRouter } from './shared';
import type { ResourcesRouterType } from './shared';

// Import registration functions for all routes
import { registerCreateResource } from './routes/create';
import { registerGetResourceUri } from './routes/get-uri';
import { registerListResources } from './routes/list';
import { registerUpdateResource } from './routes/update';
import { registerSearchResources } from './routes/search';
import { registerCreateResourceFromAnnotation } from './routes/create-from-annotation';
import { registerDetectAnnotationsStream } from './routes/detect-annotations-stream';
import { registerDetectEntities } from './routes/detect-entities';
import { registerGetResourceLLMContext } from './routes/llm-context';
import { registerGetReferenceLLMContext } from './routes/reference-llm-context';
import { registerGetReferencedBy } from './routes/referenced-by';
import { registerDiscoverContext } from './routes/discover-context';
import { registerTokenRoutes } from './routes/token';
import { registerGetResourceAnnotations } from './routes/get-annotations';
import { registerGetEvents } from './routes/events';
import { registerGetEventStream } from './routes/events-stream';

// Create main resources router
export const resourcesRouter: ResourcesRouterType = createResourceRouter();

// Register all routes
registerCreateResource(resourcesRouter);
registerListResources(resourcesRouter);
registerSearchResources(resourcesRouter);  // Must be before registerGetResourceUri to avoid {id} matching "search"
registerGetResourceUri(resourcesRouter);  // W3C content negotiation for /resources/:id - handles both metadata and raw representations
registerUpdateResource(resourcesRouter);
registerCreateResourceFromAnnotation(resourcesRouter);
registerDetectAnnotationsStream(resourcesRouter);
registerDetectEntities(resourcesRouter);
registerGetResourceLLMContext(resourcesRouter);
registerGetReferenceLLMContext(resourcesRouter);
registerGetReferencedBy(resourcesRouter);
registerDiscoverContext(resourcesRouter);
registerTokenRoutes(resourcesRouter);
registerGetResourceAnnotations(resourcesRouter);
registerGetEvents(resourcesRouter);
registerGetEventStream(resourcesRouter);