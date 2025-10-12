import { z } from 'zod';

// Re-export generic schemas from SDK
export {
  NameInputSchema,
  EmailSchema,
  URLSchema,
  JWTTokenSchema,
  validateData,
  sanitizeInput,
} from '@semiont/sdk';

/**
 * Frontend-specific validation schemas
 * These are kept in the frontend because they have web-specific security concerns
 */

// Image URL validation with security checks (web-specific)
export const ImageURLSchema = z.string()
  .url('Invalid image URL')
  .refine((url) => {
    try {
      const parsed = new URL(url);
      // Only allow https for external images
      if (parsed.hostname !== 'localhost' && parsed.protocol !== 'https:') {
        return false;
      }

      // Check for suspicious patterns
      const suspiciousPatterns = [
        'javascript:',
        'data:text/html',
        '<script',
        'onerror=',
        'onload=',
        'onclick=',
      ];

      const lowerUrl = url.toLowerCase();
      return !suspiciousPatterns.some(pattern => lowerUrl.includes(pattern));
    } catch {
      return false;
    }
  }, 'Invalid or potentially unsafe image URL')
  .refine((url) => {
    // Check file extension
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico'];
    const lowerUrl = url.toLowerCase();

    // Allow URLs without extensions (like Google profile images)
    const hasExtension = imageExtensions.some(ext => lowerUrl.includes(ext));
    const isProfileImage = lowerUrl.includes('googleusercontent.com') ||
                          lowerUrl.includes('avatars.githubusercontent.com');

    return hasExtension || isProfileImage;
  }, 'URL must point to an image file');

// OAuth user validation (Next.js auth specific)
export const OAuthUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email('Invalid email address'),
  name: z.string().nullable().transform(val => val || undefined),
  image: ImageURLSchema.nullable().transform(val => val || undefined),
  domain: z.string().min(1),
  isAdmin: z.boolean(),
  isModerator: z.boolean(),
});

// URL sanitization for images (web-specific security)
export function sanitizeImageURL(url: string): string | null {
  try {
    // Validate with schema first
    const result = ImageURLSchema.safeParse(url);
    if (!result.success) {
      console.warn('Invalid image URL:', result.error.issues);
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
