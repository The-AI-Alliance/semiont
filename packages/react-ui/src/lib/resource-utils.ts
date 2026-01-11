/**
 * Resource utilities
 * Shared helper functions for resource display and metadata
 */

/**
 * Get icon emoji based on media type
 */
export function getResourceIcon(mediaType: string | undefined): string {
  if (!mediaType) return '📄';

  const baseType = mediaType.split(';')[0]?.trim().toLowerCase() || '';

  if (baseType.startsWith('image/')) {
    return '🖼️';
  }

  switch (baseType) {
    case 'text/markdown':
      return '📝';
    case 'text/html':
      return '🌐';
    case 'text/plain':
      return '📄';
    default:
      return '📄';
  }
}

/**
 * Check if a resource supports text-based AI detection features
 *
 * Currently returns true for any text/* media type.
 * Future enhancements may include:
 * - Checking resource language/locale compatibility
 * - Validating content size limits
 * - Checking for specific text format requirements
 *
 * @param mediaType - The media type string (e.g., 'text/plain', 'text/markdown')
 * @returns true if the resource supports AI detection features
 */
export function supportsDetection(mediaType: string | undefined): boolean {
  if (!mediaType) return false;
  const baseType = mediaType.split(';')[0]?.trim().toLowerCase() || '';
  return baseType.startsWith('text/');
}
