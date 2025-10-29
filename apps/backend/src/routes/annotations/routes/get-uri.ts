/**
 * Get Annotation URI Route - W3C Content Negotiation
 *
 * Handles globally resolvable annotation URIs with content negotiation:
 * - Accept: application/ld+json -> returns JSON-LD representation
 * - Accept: text/html (or browser) -> redirects to frontend viewer
 *
 * This implements W3C Web Annotation Data Model requirement that
 * annotation URIs be globally resolvable.
 */

import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { ResourceQueryService } from '../../../services/resource-queries';
import { getBodySource } from '../../../lib/annotation-utils';
import { uriToResourceId } from '../../../lib/uri-utils';
import { prefersHtml, getFrontendUrl } from '../../../middleware/content-negotiation';

type Annotation = components['schemas']['Annotation'];
type GetAnnotationResponse = components['schemas']['GetAnnotationResponse'];

export function registerGetAnnotationUri(router: AnnotationsRouterType) {
  /**
   * GET /annotations/:id
   *
   * W3C-compliant globally resolvable annotation URI
   * Supports content negotiation:
   * - JSON-LD for machines (default)
   * - HTML redirect to frontend for browsers
   *
   * Requires resourceId query parameter for O(1) Layer 3 lookup
   */
  router.get('/annotations/:id', async (c) => {
    const { id } = c.req.param();
    const query = c.req.query();
    const resourceUriOrId = query.resourceId;

    if (!resourceUriOrId) {
      throw new HTTPException(400, { message: 'resourceId query parameter is required' });
    }

    // Extract resource ID from URI if provided as full URI
    let resourceId: string;
    try {
      resourceId = resourceUriOrId.includes('://')
        ? uriToResourceId(resourceUriOrId)
        : resourceUriOrId;
    } catch (error) {
      throw new HTTPException(400, { message: 'Invalid resourceId parameter' });
    }

    // Check if client prefers HTML (browser)
    if (prefersHtml(c)) {
      const frontendUrl = getFrontendUrl();
      const normalizedBase = frontendUrl.endsWith('/') ? frontendUrl.slice(0, -1) : frontendUrl;
      const redirectUrl = `${normalizedBase}/annotations/${id}?resourceId=${resourceId}`;
      return c.redirect(redirectUrl, 302);
    }

    // Otherwise, return JSON-LD representation
    // O(1) lookup in Layer 3 using resource ID
    const projection = await AnnotationQueryService.getResourceAnnotations(resourceId);

    // Find the annotation
    const annotation = projection.annotations.find((a: Annotation) => a.id === id);

    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found in resource' });
    }

    // Get resource metadata
    const resource = await ResourceQueryService.getResourceMetadata(resourceId);

    // If it's a linking annotation with a resolved source, get resolved resource
    let resolvedResource = null;
    const bodySource = getBodySource(annotation.body);
    if (annotation.motivation === 'linking' && bodySource) {
      // Extract ID from body source URI if needed
      const bodyDocId = bodySource.includes('://') ? uriToResourceId(bodySource) : bodySource;
      resolvedResource = await ResourceQueryService.getResourceMetadata(bodyDocId);
    }

    const response: GetAnnotationResponse = {
      annotation,
      resource,
      resolvedResource,
    };

    // Set Content-Type to JSON-LD
    c.header('Content-Type', 'application/ld+json; charset=utf-8');

    return c.json(response);
  });
}
