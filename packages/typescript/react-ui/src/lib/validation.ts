/**
 * Image-URL validation for the browser, with security checks.
 */

import type { ValidationResult } from '@semiont/core';
/**
 * Image URL validation with security checks (browser-specific)
 *
 * Validates image URLs for use in browser environments with XSS prevention.
 * Only allows HTTPS for external images, blocks suspicious patterns.
 */
export const ImageURLSchema = {
  parse(url: unknown): string {
    if (typeof url !== 'string') {
      throw new Error('URL must be a string');
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid image URL');
    }

    // Only allow https for external images
    if (parsed.hostname !== 'localhost' && parsed.protocol !== 'https:') {
      throw new Error('External images must use HTTPS');
    }

    // Check for suspicious patterns (XSS prevention)
    const suspiciousPatterns = [
      'javascript:',
      'data:text/html',
      '<script',
      'onerror=',
      'onload=',
      'onclick=',
    ];

    const lowerUrl = url.toLowerCase();
    if (suspiciousPatterns.some(pattern => lowerUrl.includes(pattern))) {
      throw new Error('Invalid or potentially unsafe image URL');
    }

    // Check file extension or known profile image domains
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico'];
    const hasExtension = imageExtensions.some(ext => lowerUrl.includes(ext));
    const isProfileImage = lowerUrl.includes('googleusercontent.com') ||
                          lowerUrl.includes('avatars.githubusercontent.com');

    if (!hasExtension && !isProfileImage) {
      throw new Error('URL must point to an image file');
    }

    return url;
  },

  safeParse(url: unknown): ValidationResult<string> {
    try {
      const validated = this.parse(url);
      return { success: true, data: validated };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid image URL',
      };
    }
  },
};

/**
 * URL sanitization for images (browser-specific security)
 *
 * Sanitizes image URLs by validating and reconstructing with only safe parts.
 * Returns null if validation fails.
 *
 * @param url - Image URL to sanitize
 * @returns Sanitized URL or null if invalid
 */
export function sanitizeImageURL(url: string): string | null {
  try {
    // Validate with schema first
    const result = ImageURLSchema.safeParse(url);
    if (!result.success) {
      console.warn('Invalid image URL:', result.error);
      return null;
    }

    // Additional sanitization
    const parsed = new URL(url);

    // Reconstruct URL with only allowed parts
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${parsed.search}`;
  } catch (error) {
    console.error('Error sanitizing image URL:', error);
    return null;
  }
}
