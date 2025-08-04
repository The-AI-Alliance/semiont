/**
 * Input validation and sanitization utilities
 * Prevents injection attacks and ensures data integrity
 */

import { ValidationResult, ValidationError } from './types.js';
import { logger } from './logger.js';

/**
 * Validate and sanitize command arguments
 */
export function validateCommand(command: string): ValidationResult<string> {
  if (!command || typeof command !== 'string') {
    return { success: false, error: 'Command must be a non-empty string' };
  }

  // Remove potentially dangerous characters
  const sanitized = command.replace(/[;&|`$(){}[\]<>]/g, '');
  
  if (sanitized !== command) {
    logger.warn('Command contained potentially dangerous characters', { 
      original: command.substring(0, 50),
      sanitized: sanitized.substring(0, 50)
    });
  }

  if (sanitized.length === 0) {
    return { success: false, error: 'Command becomes empty after sanitization' };
  }

  return { success: true, data: sanitized };
}

/**
 * Validate file paths to prevent traversal attacks
 */
export function validatePath(path: string): ValidationResult<string> {
  if (!path || typeof path !== 'string') {
    return { success: false, error: 'Path must be a non-empty string' };
  }

  // Check for path traversal attempts
  if (path.includes('..') || path.includes('~')) {
    return { success: false, error: 'Path traversal not allowed' };
  }

  // Ensure path is within allowed directories
  const allowedPrefixes = ['/tmp/', '/var/', '/usr/local/', process.cwd()];
  const isAllowed = allowedPrefixes.some(prefix => path.startsWith(prefix));
  
  if (!isAllowed && !path.startsWith('.')) {
    return { success: false, error: 'Path not in allowed directories' };
  }

  return { success: true, data: path };
}

/**
 * Validate AWS resource names/ARNs
 */
export function validateAwsResourceName(name: string): ValidationResult<string> {
  if (!name || typeof name !== 'string') {
    return { success: false, error: 'AWS resource name must be a non-empty string' };
  }

  // AWS resource name pattern
  const awsNamePattern = /^[a-zA-Z0-9\-_./]+$/;
  if (!awsNamePattern.test(name)) {
    return { success: false, error: 'Invalid AWS resource name format' };
  }

  return { success: true, data: name };
}

/**
 * Validate JSON data safely
 */
export function validateJson<T>(jsonString: string): ValidationResult<T> {
  if (!jsonString || typeof jsonString !== 'string') {
    return { success: false, error: 'JSON must be a non-empty string' };
  }

  try {
    const parsed = JSON.parse(jsonString) as T;
    return { success: true, data: parsed };
  } catch (error) {
    return { 
      success: false, 
      error: `Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * Validate email addresses
 */
export function validateEmail(email: string): ValidationResult<string> {
  if (!email || typeof email !== 'string') {
    return { success: false, error: 'Email must be a non-empty string' };
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return { success: false, error: 'Invalid email format' };
  }

  return { success: true, data: email.toLowerCase() };
}

/**
 * Validate environment variables
 */
export function validateEnvVar(name: string): ValidationResult<string> {
  const value = process.env[name];
  
  if (!value) {
    return { success: false, error: `Environment variable ${name} is not set` };
  }

  if (value === 'undefined' || value === 'null') {
    return { success: false, error: `Environment variable ${name} has invalid value` };
  }

  return { success: true, data: value };
}

/**
 * Validate and sanitize user input
 */
export function sanitizeUserInput(input: string, maxLength: number = 255): ValidationResult<string> {
  if (!input || typeof input !== 'string') {
    return { success: false, error: 'Input must be a non-empty string' };
  }

  if (input.length > maxLength) {
    return { success: false, error: `Input too long (max ${maxLength} characters)` };
  }

  // Remove potentially dangerous HTML/JS
  const sanitized = input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();

  return { success: true, data: sanitized };
}

/**
 * Create validation error with context
 */
export function createValidationError(message: string, context?: Record<string, any>): ValidationError {
  logger.error('Validation failed', { message, ...context });
  return new ValidationError(message, context);
}

/**
 * Assert validation result and throw if invalid
 */
export function assertValid<T>(result: ValidationResult<T>, context?: string): T {
  if (!result.success) {
    throw createValidationError(
      context ? `${context}: ${result.error}` : result.error || 'Validation failed'
    );
  }
  return result.data!;
}