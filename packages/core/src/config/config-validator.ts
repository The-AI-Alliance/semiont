/**
 * Config Schema Validator
 *
 * Validates configuration data against JSON Schema using Ajv (JSON Schema validator).
 * Provides runtime validation for semiont.json and environment config files.
 */

import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import configSchema from './config.schema.json';

// Initialize Ajv with config-compatible settings
const ajv = new Ajv({
  allErrors: true,      // Return all errors, not just the first one
  coerceTypes: true,    // Coerce types (e.g., "123" -> 123)
  removeAdditional: false, // Don't remove additional properties
  useDefaults: true,    // Apply default values from schema
  strict: false
});

// Add format validators (email, uri, date-time, etc.)
addFormats(ajv);

// Load schema
ajv.addSchema(configSchema, 'config');

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null;
  errorMessage?: string;
}

/**
 * Validate semiont.json config
 */
export function validateSemiontConfig(data: unknown): ValidationResult {
  const validate = ajv.getSchema('config#/definitions/SemiontConfig');
  if (!validate) {
    throw new Error('SemiontConfig schema not found');
  }

  const valid = validate(data);

  if (!valid) {
    return {
      valid: false,
      errors: validate.errors || null,
      errorMessage: formatErrors(validate.errors || [])
    };
  }

  return { valid: true, errors: null };
}

/**
 * Validate environment config (environments/*.json)
 */
export function validateEnvironmentConfig(data: unknown): ValidationResult {
  const validate = ajv.getSchema('config#/definitions/EnvironmentConfig');
  if (!validate) {
    throw new Error('EnvironmentConfig schema not found');
  }

  const valid = validate(data);

  if (!valid) {
    return {
      valid: false,
      errors: validate.errors || null,
      errorMessage: formatErrors(validate.errors || [])
    };
  }

  return { valid: true, errors: null };
}

/**
 * Validate site config
 */
export function validateSiteConfig(data: unknown): ValidationResult {
  const validate = ajv.getSchema('config#/definitions/SiteConfig');
  if (!validate) {
    throw new Error('SiteConfig schema not found');
  }

  const valid = validate(data);

  if (!valid) {
    return {
      valid: false,
      errors: validate.errors || null,
      errorMessage: formatErrors(validate.errors || [])
    };
  }

  return { valid: true, errors: null };
}

/**
 * Format validation errors into human-readable message
 */
function formatErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) return 'Validation failed';

  const messages = errors.map(err => {
    const path = err.instancePath || 'root';
    const message = err.message || 'validation error';

    if (err.keyword === 'required' && 'missingProperty' in err.params) {
      return `Missing required property: ${err.params.missingProperty}`;
    }

    if (err.keyword === 'type' && 'type' in err.params) {
      return `${path}: ${message} (expected ${err.params.type})`;
    }

    if (err.keyword === 'enum' && 'allowedValues' in err.params) {
      return `${path}: must be one of [${(err.params.allowedValues as string[]).join(', ')}]`;
    }

    if (err.keyword === 'format') {
      return `${path}: invalid format (${message})`;
    }

    if (err.keyword === 'minLength' || err.keyword === 'minItems') {
      return `${path}: ${message}`;
    }

    return `${path}: ${message}`;
  });

  return messages.join('; ');
}
