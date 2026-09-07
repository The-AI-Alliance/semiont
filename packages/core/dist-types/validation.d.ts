/**
 * Generic validation utilities for @semiont/http-transport
 *
 * Pure TypeScript validation with no external dependencies.
 * Safe to use in any JavaScript environment (Node.js, browser, Deno, etc.)
 */
/**
 * Validation result types
 */
export type ValidationSuccess<T> = {
    success: true;
    data: T;
};
export type ValidationFailure = {
    success: false;
    error: string;
    details?: string[];
};
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;
/**
 * JWT Token validation
 *
 * Validates JWT token format (header.payload.signature).
 * Does not verify signature - use for format validation only.
 */
export declare const JWTTokenSchema: {
    parse(token: unknown): string;
    safeParse(token: unknown): ValidationResult<string>;
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
export declare function validateData<T>(schema: {
    parse(data: unknown): T;
}, data: unknown): ValidationResult<T>;
/**
 * Email validation helper
 *
 * Validates email format using RFC 5322 simplified regex.
 *
 * @param email - Email address to validate
 * @returns true if valid email format
 */
export declare function isValidEmail(email: string): boolean;
