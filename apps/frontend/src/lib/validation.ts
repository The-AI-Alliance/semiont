import { z } from 'zod';

// Input validation schemas
export const NameInputSchema = z.string()
  .min(1, 'Name cannot be empty')
  .max(50, 'Name must be 50 characters or less')
  .regex(/^[a-zA-Z0-9\s\-']+$/, 'Name can only contain letters, numbers, spaces, hyphens, and apostrophes')
  .transform(str => str.trim());

export const EmailSchema = z.string()
  .email('Invalid email address')
  .min(1, 'Email is required')
  .max(255, 'Email must be 255 characters or less');

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

// Image URL validation with security checks
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

// OAuth token validation
export const JWTTokenSchema = z.string()
  .min(1, 'Token is required')
  .regex(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*$/, 'Invalid JWT token format');

// OAuth user validation
export const OAuthUserSchema = z.object({
  id: z.string().min(1),
  email: EmailSchema,
  name: z.string().nullable().transform(val => val || undefined),
  image: ImageURLSchema.nullable().transform(val => val || undefined),
  domain: z.string().min(1),
  isAdmin: z.boolean(),
  isModerator: z.boolean(),
});

// Sanitization utilities
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

// URL sanitization for images
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

// Validation helper with error formatting
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