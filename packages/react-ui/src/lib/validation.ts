/**
 * Frontend-specific validation utilities
 *
 * Browser and Next.js specific validation with security checks.
 * For generic validation utilities, see @semiont/api-client/utils/validation
 */

import { isValidEmail, type ValidationResult } from '@semiont/api-client';

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
 * OAuth user validation (Next.js NextAuth specific)
 *
 * Validates user objects returned from OAuth providers.
 * Includes domain validation for access control.
 */
export interface OAuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  domain: string;
  isAdmin: boolean;
  isModerator: boolean;
}

export const OAuthUserSchema = {
  parse(data: unknown): OAuthUser {
    if (!data || typeof data !== 'object') {
      throw new Error('User data must be an object');
    }

    const user = data as Record<string, unknown>;

    // Validate required string fields
    if (typeof user.id !== 'string' || user.id.length === 0) {
      throw new Error('User ID is required');
    }

    if (typeof user.email !== 'string' || !isValidEmail(user.email)) {
      throw new Error('Valid email address is required');
    }

    if (typeof user.domain !== 'string' || user.domain.length === 0) {
      throw new Error('Domain is required');
    }

    // Validate optional fields
    if (user.name !== null && user.name !== undefined && typeof user.name !== 'string') {
      throw new Error('Name must be a string or null');
    }

    if (user.image !== null && user.image !== undefined && typeof user.image !== 'string') {
      throw new Error('Image must be a string or null');
    }

    // Validate boolean fields
    if (typeof user.isAdmin !== 'boolean') {
      throw new Error('isAdmin must be a boolean');
    }

    if (typeof user.isModerator !== 'boolean') {
      throw new Error('isModerator must be a boolean');
    }

    const result: OAuthUser = {
      id: user.id,
      email: user.email,
      domain: user.domain,
      isAdmin: user.isAdmin,
      isModerator: user.isModerator,
    };

    // Only add optional fields if they exist
    if (user.name !== undefined) {
      result.name = user.name as string | null;
    }
    if (user.image !== undefined) {
      result.image = user.image as string | null;
    }

    return result;
  },

  safeParse(data: unknown): ValidationResult<OAuthUser> {
    try {
      const validated = this.parse(data);
      return { success: true, data: validated };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid user data',
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
