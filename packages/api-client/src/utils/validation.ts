/**
 * Generic validation utilities for @semiont/api-client
 *
 * Pure TypeScript validation with no external dependencies.
 * Safe to use in any JavaScript environment (Node.js, browser, Deno, etc.)
 */

/**
 * Validation result types
 */
export type ValidationSuccess<T> = { success: true; data: T };
export type ValidationFailure = { success: false; error: string; details?: string[] };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/**
 * JWT Token validation
 *
 * Validates JWT token format (header.payload.signature).
 * Does not verify signature - use for format validation only.
 */
export const JWTTokenSchema = {
  parse(token: unknown): string {
    if (typeof token !== 'string') {
      throw new Error('Token must be a string');
    }
    if (!token || token.length === 0) {
      throw new Error('Token is required');
    }
    // JWT format: header.payload.signature
    const jwtRegex = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*$/;
    if (!jwtRegex.test(token)) {
      throw new Error('Invalid JWT token format');
    }
    return token;
  },

  safeParse(token: unknown): ValidationResult<string> {
    try {
      const validated = this.parse(token);
      return { success: true, data: validated };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid JWT token',
      };
    }
  },
};

/**
 * Generic validation helper with error formatting
 *
 * Wraps any schema's parse method with try/catch and returns ValidationResult.
 *
 * @example
 * ```typescript
 * const result = validateData(JWTTokenSchema, 'eyJ...');
 * if (result.success) {
 *   console.log('Valid token:', result.data);
 * } else {
 *   console.error('Invalid:', result.error);
 * }
 * ```
 */
export function validateData<T>(
  schema: { parse(data: unknown): T },
  data: unknown
): ValidationResult<T> {
  try {
    const validated = schema.parse(data);
    return { success: true, data: validated };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Validation failed',
    };
  }
}

/**
 * Email validation helper
 *
 * Validates email format using RFC 5322 simplified regex.
 *
 * @param email - Email address to validate
 * @returns true if valid email format
 */
export function isValidEmail(email: string): boolean {
  if (email.length < 1 || email.length > 255) {
    return false;
  }
  // RFC 5322 simplified email regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
