import { createResourceRouter } from './shared';
import type { ResourcesRouterType } from './shared';

import { registerCreateResource } from './routes/create';
import { registerGetResourceUri } from './routes/get-uri';
import { registerUpdateResource } from './routes/update';
import { registerGetEventStream } from './routes/events-stream';
import { registerCreateAnnotation } from './routes/create-annotation';
import { registerGetAnnotationHistory } from '../annotations/routes/history';

export function createResourcesRouter(): ResourcesRouterType {
  const resourcesRouter: ResourcesRouterType = createResourceRouter();

  // Binary upload
  registerCreateResource(resourcesRouter);

  // Annotation creation (Step 5 — assembly moves to Stower)
  registerCreateAnnotation(resourcesRouter);
  registerGetAnnotationHistory(resourcesRouter);

  // SSE event stream (Step 6 — needs Last-Event-ID replay)
  registerGetEventStream(resourcesRouter);

  // Binary content + PATCH (stays HTTP)
  registerGetResourceUri(resourcesRouter);
  registerUpdateResource(resourcesRouter);

  return resourcesRouter;
}
