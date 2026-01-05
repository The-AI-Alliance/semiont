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
import { EventQuery } from '@semiont/event-sourcing';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { getFrontendUrl } from '../../../middleware/content-negotiation';
import { FilesystemRepresentationStore } from '@semiont/content';
import { getPrimaryRepresentation, getPrimaryMediaType, decodeRepresentation } from '@semiont/api-client';
import { ResourceQueryService } from '../../../services/resource-queries';
import { resourceId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';

type GetResourceResponse = components['schemas']['GetResourceResponse'];
type Annotation = components['schemas']['Annotation'];

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
    const config = c.get('config');

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
    const basePath = config.services.filesystem!.path;

    // If requesting raw representation (text/plain, text/markdown, images, etc.)
    if (acceptHeader.includes('text/') || acceptHeader.includes('image/') || acceptHeader.includes('application/pdf')) {
      const projectRoot = config._metadata?.projectRoot;
      const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

      // Get resource metadata from view storage
      const resource = await ResourceQueryService.getResourceMetadata(resourceId(id), config);
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

      // Set Content-Type header from representation mediaType (includes charset if specified)
      const mediaType = getPrimaryMediaType(resource);
      if (mediaType) {
        c.header('Content-Type', mediaType);
      }

      // For images, return binary data; for text, decode with correct charset
      if (mediaType?.startsWith('image/')) {
        // Convert Buffer to Uint8Array for Hono compatibility
        return c.newResponse(new Uint8Array(content), 200, { 'Content-Type': mediaType });
      } else {
        return c.text(decodeRepresentation(content, mediaType || 'text/plain'));
      }
    }

    // Otherwise, return JSON-LD metadata (default)

    // Read from event store: materializes view from events
    const eventStore = await createEventStore(config);
    const query = new EventQuery(eventStore.log.storage);
    const events = await query.getResourceEvents(resourceId(id));
    const stored = await eventStore.views.materializer.materialize(events, resourceId(id));

    if (!stored) {
      throw new HTTPException(404, { message: 'Resource not found' });
    }

    const annotations = stored.annotations.annotations;
    const entityReferences = annotations.filter((a: Annotation) => {
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
