/**
 * MIME type utilities for Semiont
 *
 * Initial support for:
 * - text/plain
 * - text/markdown
 * - image/png
 * - image/jpeg
 */

/**
 * Map MIME type to file extension
 */
export function getExtensionForMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    'text/plain': 'txt',
    'text/markdown': 'md',
    'image/png': 'png',
    'image/jpeg': 'jpg',
  };

  return map[mimeType] || 'dat'; // fallback to .dat for unknown types
}

/**
 * Detect if MIME type is an image (png or jpeg only for now)
 */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg';
}

/**
 * Detect if MIME type is text-based (plain or markdown only for now)
 */
export function isTextMimeType(mimeType: string): boolean {
  return mimeType === 'text/plain' || mimeType === 'text/markdown';
}

/**
 * Get category for MIME type (for routing to appropriate viewer)
 */
export type MimeCategory = 'text' | 'image' | 'unsupported';

export function getMimeCategory(mimeType: string): MimeCategory {
  if (isTextMimeType(mimeType)) {
    return 'text';
  }
  if (isImageMimeType(mimeType)) {
    return 'image';
  }
  return 'unsupported';
}
