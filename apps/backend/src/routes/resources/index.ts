// Main resources router that combines all individual route files
import { createResourceRouter } from './shared';
import type { ResourcesRouterType } from './shared';
import type { JobQueue } from '@semiont/jobs';

// Import registration functions for all routes
import { registerCreateResource } from './routes/create';
import { registerGetResourceUri } from './routes/get-uri';
import { registerListResources } from './routes/list';
import { registerUpdateResource } from './routes/update';
import { registerAnnotateReferencesStream } from './routes/annotate-references-stream';
import { registerAnnotateHighlightsStream } from './routes/annotate-highlights-stream';
import { registerAnnotateAssessmentsStream } from './routes/annotate-assessments-stream';
import { registerAnnotateCommentsStream } from './routes/annotate-comments-stream';
import { registerAnnotateTagsStream } from './routes/annotate-tags-stream';
import { registerGetResourceLLMContext } from './routes/llm-context';
import { registerGetAnnotationLLMContext } from './routes/annotation-llm-context';
import { registerGetReferencedBy } from './routes/referenced-by';
import { registerTokenRoutes } from './routes/token';
import { registerGetResourceAnnotations } from './routes/get-annotations';
import { registerGetEvents } from './routes/events';
import { registerGetEventStream } from './routes/events-stream';

// Nested annotation routes
import { registerCreateAnnotation } from './routes/create-annotation';
import { registerGetAnnotation } from './routes/get-annotation';
import { registerDeleteAnnotation } from './routes/delete-annotation';
import { registerUpdateAnnotationBody } from './routes/update-annotation-body';
import { registerYieldResourceStream } from './routes/yield-resource-stream';
import { registerGetAnnotationHistory } from '../annotations/routes/history';

// Factory function to create resources router with JobQueue
export function createResourcesRouter(jobQueue: JobQueue): ResourcesRouterType {
  const resourcesRouter: ResourcesRouterType = createResourceRouter();

// Register all routes
// NOTE: Register specific paths before generic :id patterns to avoid route conflicts
// Order: exact paths → literal segments → :id with suffixes → generic :id

// Exact collection paths (no params)
registerCreateResource(resourcesRouter);  // POST /resources
registerListResources(resourcesRouter);  // GET /resources

// Routes with literal second segment (before :id routes)
registerTokenRoutes(resourcesRouter);  // GET /api/clone-tokens/:token, POST /api/clone-tokens/create-resource, POST /resources/:id/clone-with-token

  // Routes with :id and specific suffixes
  registerAnnotateReferencesStream(resourcesRouter, jobQueue);  // POST /resources/:id/annotate-references-stream
  registerAnnotateHighlightsStream(resourcesRouter, jobQueue);  // POST /resources/:id/annotate-highlights-stream
  registerAnnotateAssessmentsStream(resourcesRouter, jobQueue);  // POST /resources/:id/annotate-assessments-stream
  registerAnnotateCommentsStream(resourcesRouter, jobQueue);  // POST /resources/:id/annotate-comments-stream
  registerAnnotateTagsStream(resourcesRouter, jobQueue);  // POST /resources/:id/annotate-tags-stream
  registerGetResourceLLMContext(resourcesRouter);  // GET /resources/:id/llm-context
  registerGetAnnotationLLMContext(resourcesRouter);  // GET /resources/:resourceId/annotations/:annotationId/llm-context
  registerGetReferencedBy(resourcesRouter);  // GET /resources/:id/referenced-by

  // Annotation routes (nested under resources) - must be before generic :id route
  registerGetResourceAnnotations(resourcesRouter);  // GET /resources/:id/annotations (list)
  registerCreateAnnotation(resourcesRouter);  // POST /resources/:id/annotations
  registerGetAnnotation(resourcesRouter);  // GET /resources/:resourceId/annotations/:annotationId
  registerUpdateAnnotationBody(resourcesRouter);  // PUT /resources/:resourceId/annotations/:annotationId/body
  registerYieldResourceStream(resourcesRouter, jobQueue);  // POST /resources/:resourceId/annotations/:annotationId/yield-resource-stream
  registerGetAnnotationHistory(resourcesRouter);  // GET /resources/:resourceId/annotations/:annotationId/history
  registerDeleteAnnotation(resourcesRouter);  // DELETE /resources/:resourceId/annotations/:annotationId

  // Event routes
  registerGetEvents(resourcesRouter);  // GET /resources/:id/events
  registerGetEventStream(resourcesRouter);  // GET /resources/:id/events/stream

  // Generic routes with :id parameter - MUST BE LAST
  registerGetResourceUri(resourcesRouter);  // W3C content negotiation for /resources/:id - handles both metadata and raw representations
  registerUpdateResource(resourcesRouter);  // PATCH /resources/:id (handles archive via {archived: true})

  return resourcesRouter;
}