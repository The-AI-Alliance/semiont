import { createResourceRouter } from './shared';
import type { ResourcesRouterType } from './shared';

import { registerCreateResource } from './routes/create';
import { registerGetResourceUri } from './routes/get-uri';

export function createResourcesRouter(): ResourcesRouterType {
  const resourcesRouter: ResourcesRouterType = createResourceRouter();

  registerCreateResource(resourcesRouter);
  registerGetResourceUri(resourcesRouter);

  return resourcesRouter;
}
