/**
 * Validation utilities
 */

import { z, ZodError, ZodSchema } from 'zod';
import { ValidationError } from './errors';

/**
 * Validate data against a Zod schema
 * @param schema The Zod schema to validate against
 * @param data The data to validate
 * @returns The validated data
 * @throws ValidationError if validation fails
 */
export function validate<T>(schema: ZodSchema<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`);
      throw new ValidationError(`Validation failed: ${issues.join(', ')}`, {
        errors: error.issues
      });
    }
    throw error;
  }
}

/**
 * Safe validation that returns a result object instead of throwing
 * @param schema The Zod schema to validate against
 * @param data The data to validate
 * @returns Object with success flag and data or error
 */
export function safeParse<T>(schema: ZodSchema<T>, data: unknown):
  { success: true; data: T } | { success: false; error: ValidationError } {
  try {
    const result = schema.parse(data);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`);
      return {
        success: false,
        error: new ValidationError(`Validation failed: ${issues.join(', ')}`, {
          errors: error.issues
        })
      };
    }
    return {
      success: false,
      error: new ValidationError('Unknown validation error')
    };
  }
}

/**
 * Common validation schemas
 */
export const CommonSchemas = {
  uuid: z.string().uuid(),
  email: z.string().email(),
  url: z.string().url(),
  nonEmptyString: z.string().min(1),
  positiveInt: z.number().int().positive(),
  isoDate: z.string().datetime(),
} as const;

/**
 * Generic input validation schemas (framework-agnostic)
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
 * @param schema Zod schema to validate against
 * @param data Data to validate
 * @returns Success object with data or failure object with formatted errors
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
 * Sanitization utilities
 */

// Sanitize text input by removing HTML tags and escaping special characters
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