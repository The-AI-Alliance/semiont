/**
 * Get Resource URI Route - W3C Content Negotiation
 *
 * Single endpoint for all resource representations via content negotiation:
 * - Accept: application/ld+json -> JSON-LD metadata via EventBus (default)
 * - Accept: text/plain, text/markdown, etc. -> raw representation (binary, stays direct)
 * - ?view=semiont -> redirects to Semiont frontend viewer
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { getFrontendUrl } from '../../../middleware/content-negotiation';
import { getPrimaryMediaType, decodeRepresentation } from '@semiont/api-client';
import { ResourceContext } from '@semiont/make-meaning';
import { resourceId } from '@semiont/core';
import { eventBusRequest } from '../../../utils/event-bus-request';
import { getLogger } from '../../../logger';

const getRouteLogger = () => getLogger().child({ component: 'get-resource-uri' });

export function registerGetResourceUri(router: ResourcesRouterType) {
  router.get('/resources/:id', async (c) => {
    const { id } = c.req.param();

    // Check for explicit view=semiont query parameter
    const view = c.req.query('view');
    if (view === 'semiont') {
      const frontendUrl = getFrontendUrl();
      const normalizedBase = frontendUrl.endsWith('/') ? frontendUrl.slice(0, -1) : frontendUrl;
      const redirectUrl = `${normalizedBase}/know/resource/${id}`;
      return c.redirect(redirectUrl, 302);
    }

    // Check Accept header for content negotiation
    const acceptHeader = c.req.header('Accept') || 'application/ld+json';

    // If requesting raw representation (text/plain, text/markdown, images, etc.)
    // Binary content stays direct — excluded from EventBus by design
    if (acceptHeader.includes('text/') || acceptHeader.includes('image/') || acceptHeader.includes('application/pdf')) {
      const { knowledgeSystem: { kb } } = c.get('makeMeaning');

      let resource: any;
      try {
        resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
      } catch (error: any) {
        getRouteLogger().error('Failed to get resource metadata', {
          resourceId: id,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw new HTTPException(500, { message: 'Failed to retrieve resource' });
      }

      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      if (!resource.storageUri) {
        throw new HTTPException(404, { message: 'Resource representation not found' });
      }

      const content = await kb.content.retrieve(resource.storageUri);
      if (!content) {
        throw new HTTPException(404, { message: 'Resource representation not found' });
      }

      const mediaType = getPrimaryMediaType(resource);
      if (mediaType) {
        c.header('Content-Type', mediaType);
      }

      if (mediaType?.startsWith('image/') || mediaType === 'application/pdf') {
        return c.newResponse(new Uint8Array(content), 200, { 'Content-Type': mediaType });
      } else {
        return c.text(decodeRepresentation(content, mediaType || 'text/plain'));
      }
    }

    // JSON-LD metadata path — delegate to EventBus → Gatherer
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:resource-requested',
        { correlationId, resourceId: resourceId(id) },
        'browse:resource-result',
        'browse:resource-failed',
      );

      c.header('Content-Type', 'application/ld+json; charset=utf-8');
      return c.json(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Resource not found') {
          throw new HTTPException(404, { message: 'Resource not found' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });
}
