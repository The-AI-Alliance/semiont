import { z } from 'zod';

/**
 * Generic validation schemas (copied from SDK for frontend use)
 * Frontend still needs Zod for web-specific validation, so we copy these basics
 */

// Name input validation
export const NameInputSchema = z.string()
  .min(1, 'Name cannot be empty')
  .max(50, 'Name must be 50 characters or less')
  .regex(/^[a-zA-Z0-9\s\-']+$/, 'Name can only contain letters, numbers, spaces, hyphens, and apostrophes')
  .transform(str => str.trim());

// Email validation
export const EmailSchema = z.string()
  .email('Invalid email address')
  .min(1, 'Email is required')
  .max(255, 'Email must be 255 characters or less');

// URL validation with protocol check
export const URLSchema = z.string()
  .url('Invalid URL')
  .refine((url) => {
    try {
      const parsed = new URL(url);
      // Only allow http and https protocols
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }, 'Only HTTP and HTTPS URLs are allowed');

// JWT Token validation
export const JWTTokenSchema = z.string()
  .min(1, 'Token is required')
  .regex(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*$/, 'Invalid JWT token format');

/**
 * Validation helper with error formatting
 */
export function validateData<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string; details?: string[] } {
  try {
    const validated = schema.parse(data);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues.map(err => `${err.path.join('.')}: ${err.message}`);
      return {
        success: false,
        error: 'Validation failed',
        details,
      };
    }
    return {
      success: false,
      error: 'Unknown validation error',
    };
  }
}

/**
 * Sanitize text input by removing HTML tags and escaping special characters
 */
export function sanitizeInput(input: string): string {
  // Remove any HTML tags
  const withoutTags = input.replace(/<[^>]*>/g, '');

  // Escape special HTML characters
  const escaped = withoutTags
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');

  return escaped.trim();
}

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
  name: z.string().optional().transform(val => val || undefined),
  image: z.string().optional().transform(val => val || undefined),
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
