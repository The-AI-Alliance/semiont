/**
 * URI utilities for W3C annotations
 *
 * Converts between full resource URIs and short IDs.
 */

import { resourceId, type ResourceId } from './identifiers';

/**
 * Extract resource ID from a full URI or return a bare ID as-is.
 *
 * @param uriOrId - Full resource URI (e.g., "https://api.semiont.app/resources/doc-abc123") or bare ID
 * @returns Short resource ID (e.g., "doc-abc123")
 * @throws Error if URI contains `/resources/` but format is invalid
 */
export function uriToResourceId(uriOrId: string): ResourceId {
  if (!uriOrId.includes('/')) {
    return resourceId(uriOrId);
  }
  const match = uriOrId.match(/\/resources\/([^/]+)/);
  if (!match || !match[1]) {
    throw new Error(`Invalid resource URI: ${uriOrId}`);
  }
  return resourceId(match[1]);
}
