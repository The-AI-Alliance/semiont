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