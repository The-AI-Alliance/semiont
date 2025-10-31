/**
 * Extract resource ID from a URI or return the ID if already short
 *
 * Handles both:
 * - Full URIs: "http://localhost:4000/resources/04f291f3c0f3e006d39677221fe6f93c"
 * - Short IDs: "04f291f3c0f3e006d39677221fe6f93c"
 *
 * @param uriOrId - Full URI or short resource ID
 * @returns Short resource ID suitable for frontend routes
 */
export function extractResourceId(uriOrId: string): string {
  // Handle both URIs and bare IDs (defensive)
  if (uriOrId.includes('/')) {
    return uriOrId.split('/').pop() || uriOrId;
  }
  return uriOrId;
}
