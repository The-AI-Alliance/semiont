/**
 * Get Resource URI Route - W3C Content Negotiation
 *
 * Single endpoint for all resource representations via content negotiation:
 * - Accept: application/ld+json -> returns JSON-LD metadata (default)
 * - Accept: text/plain, text/markdown, etc. -> returns raw representation
 * - ?view=semiont -> redirects to Semiont frontend viewer
 *
 * This implements W3C Web Annotation Data Model requirement that
 * resource URIs be globally resolvable.
 */

import { HTTPException } from 'hono/http-exception';
import { createEventStore } from '../../../services/event-store-service';
import { EventQuery } from '../../../events/query/event-query';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';
import { getFilesystemConfig } from '../../../config/environment-loader';
import { getFrontendUrl } from '../../../middleware/content-negotiation';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getPrimaryRepresentation, getPrimaryMediaType } from '../../../utils/resource-helpers';
import { ResourceQueryService } from '../../../services/resource-queries';

type GetResourceResponse = components['schemas']['GetResourceResponse'];

export function registerGetResourceUri(router: ResourcesRouterType) {
  /**
   * GET /resources/:id
   *
   * W3C-compliant globally resolvable resource URI with full content negotiation:
   * - Accept: application/ld+json -> JSON-LD metadata (default)
   * - Accept: text/plain, text/markdown, etc. -> raw representation
   * - ?view=semiont -> 302 redirect to Semiont frontend viewer
   */
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
    const basePath = getFilesystemConfig().path;

    // If requesting raw representation (text/plain, text/markdown, etc.)
    if (acceptHeader.includes('text/') || acceptHeader.includes('application/pdf')) {
      const repStore = new FilesystemRepresentationStore({ basePath });

      // Get resource metadata from Layer 3
      const resource = await ResourceQueryService.getResourceMetadata(id);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      // Get primary representation
      const primaryRep = getPrimaryRepresentation(resource);
      if (!primaryRep || !primaryRep.checksum || !primaryRep.mediaType) {
        throw new HTTPException(404, { message: 'Resource representation not found' });
      }

      // Read representation from RepresentationStore using content-addressed lookup
      const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
      if (!content) {
        throw new HTTPException(404, { message: 'Resource representation not found' });
      }

      // Set Content-Type header from representation mediaType
      const mediaType = getPrimaryMediaType(resource);
      if (mediaType) {
        c.header('Content-Type', mediaType);
      }
      return c.text(content.toString('utf-8'));
    }

    // Otherwise, return JSON-LD metadata (default)

    // Read from Layer 2/3: Event store builds/loads projection
    const eventStore = await createEventStore(basePath);
    const query = new EventQuery(eventStore.storage);
    const events = await query.getResourceEvents(id);
    const stored = await eventStore.projector.projectResource(events, id);

    if (!stored) {
      throw new HTTPException(404, { message: 'Resource not found' });
    }

    const annotations = stored.annotations.annotations;
    const entityReferences = annotations.filter(a => {
      if (a.motivation !== 'linking') return false;
      const entityTypes = getEntityTypes({ body: a.body });
      return entityTypes.length > 0;
    });

    const response: GetResourceResponse = {
      resource: stored.resource,
      annotations,
      entityReferences,
    };

    // Set Content-Type to JSON-LD
    c.header('Content-Type', 'application/ld+json; charset=utf-8');

    return c.json(response);
  });
}
