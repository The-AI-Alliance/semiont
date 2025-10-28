/**
 * Get Document URI Route - W3C Content Negotiation
 *
 * Handles globally resolvable document URIs with content negotiation:
 * - Accept: application/ld+json -> returns JSON-LD representation
 * - Accept: text/html (or browser) -> redirects to frontend viewer
 *
 * This implements W3C Web Annotation Data Model requirement that
 * document URIs be globally resolvable.
 */

import { HTTPException } from 'hono/http-exception';
import { createEventStore } from '../../../services/event-store-service';
import { EventQuery } from '../../../events/query/event-query';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';
import { getFilesystemConfig } from '../../../config/environment-loader';
import { prefersHtml, getFrontendUrl } from '../../../middleware/content-negotiation';

type GetDocumentResponse = components['schemas']['GetDocumentResponse'];

export function registerGetDocumentUri(router: DocumentsRouterType) {
  /**
   * GET /documents/:id
   *
   * W3C-compliant globally resolvable document URI
   * Supports content negotiation:
   * - JSON-LD for machines (default)
   * - HTML redirect to frontend for browsers
   */
  router.get('/documents/:id', async (c) => {
    const { id } = c.req.param();

    // Check if client prefers HTML (browser)
    if (prefersHtml(c)) {
      const frontendUrl = getFrontendUrl();
      const normalizedBase = frontendUrl.endsWith('/') ? frontendUrl.slice(0, -1) : frontendUrl;
      const redirectUrl = `${normalizedBase}/know/document/${id}`;
      return c.redirect(redirectUrl, 302);
    }

    // Otherwise, return JSON-LD representation
    const basePath = getFilesystemConfig().path;

    // Read from Layer 2/3: Event store builds/loads projection
    const eventStore = await createEventStore(basePath);
    const query = new EventQuery(eventStore.storage);
    const events = await query.getDocumentEvents(id);
    const stored = await eventStore.projector.projectDocument(events, id);

    if (!stored) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    const annotations = stored.annotations.annotations;
    const entityReferences = annotations.filter(a => {
      if (a.motivation !== 'linking') return false;
      const entityTypes = getEntityTypes({ body: a.body });
      return entityTypes.length > 0;
    });

    const response: GetDocumentResponse = {
      document: stored.document,
      annotations,
      entityReferences,
    };

    // Set Content-Type to JSON-LD
    c.header('Content-Type', 'application/ld+json; charset=utf-8');

    return c.json(response);
  });
}
