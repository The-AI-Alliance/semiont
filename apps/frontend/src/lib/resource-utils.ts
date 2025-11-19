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
