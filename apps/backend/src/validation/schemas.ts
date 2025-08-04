// Request Validation Schemas
import { z } from 'zod';

// Auth request schemas
export const GoogleAuthSchema = z.object({
  access_token: z.string().min(1, 'Access token is required'),
});

// Parameter schemas
export const HelloParamsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

// Common validation helpers
export const EmailSchema = z.string().email('Invalid email format');
export const CuidSchema = z.string().cuid('Invalid ID format');

// JWT Payload validation schema
export const JWTPayloadSchema = z.object({
  userId: CuidSchema,
  email: EmailSchema,
  name: z.string().min(1).max(255).optional(),
  domain: z.string().min(1).max(100),
  provider: z.string().min(1).max(50),
  isAdmin: z.boolean(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).refine(
  (data) => data.exp > data.iat,
  {
    message: "Token expiration must be after issued time",
    path: ["exp"],
  }
).refine(
  (data) => data.exp > Math.floor(Date.now() / 1000),
  {
    message: "Token has expired",
    path: ["exp"],
  }
);

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
      const errorMessage = error.errors.map(err => 
        `${err.path.join('.')}: ${err.message}`
      ).join(', ');
      
      return { 
        success: false, 
        error: errorMessage,
        details: error.flatten()
      };
    }
    return { success: false, error: 'Validation failed' };
  }
}

// Type exports for use in API types
export type GoogleAuthRequest = z.infer<typeof GoogleAuthSchema>;
export type HelloParams = z.infer<typeof HelloParamsSchema>;
export type ValidatedJWTPayload = z.infer<typeof JWTPayloadSchema>;