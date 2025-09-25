// Request Validation Schemas
import { z } from '@hono/zod-openapi';
// Import shared schemas from the api-types package
import { 
  GoogleAuthSchema, 
  EmailSchema,
  CuidSchema,
  JWTPayloadSchema
} from '@semiont/api-contracts';

// Re-export shared schemas for backward compatibility
export { GoogleAuthSchema, EmailSchema, CuidSchema, JWTPayloadSchema };

// Validation result types
export type ValidationResult<T> = 
  | { success: true; data: T }
  | { success: false; error: string; details?: any };

// Validation helper function
export function validateData<T>(
  schema: z.ZodSchema<T>, 
  data: unknown
): ValidationResult<T> {
  try {
    const result = schema.parse(data);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = error.issues.map((err: any) => 
        `${err.path.join('.')}: ${err.message}`
      ).join(', ');
      
      return { 
        success: false, 
        error: errorMessage || 'Validation failed',
        details: error.flatten()
      };
    }
    return { success: false, error: 'Validation failed' };
  }
}

// Type exports for use in API types
export type GoogleAuthRequest = z.infer<typeof GoogleAuthSchema>;
