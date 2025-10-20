/**
 * OpenAPI Schema Validator
 *
 * Validates data against OpenAPI component schemas using Ajv (JSON Schema validator).
 * This enables spec-first architecture where openapi.json is the source of truth.
 */

import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import openapiSpec from '../../public/openapi.json';

// Initialize Ajv with OpenAPI-compatible settings
const ajv = new Ajv({
  allErrors: true,      // Return all errors, not just the first one
  coerceTypes: true,    // Coerce types (e.g., "123" -> 123)
  removeAdditional: false, // Don't remove additional properties
});

// Add format validators (email, uri, date-time, etc.)
addFormats(ajv);

// Load all schemas from OpenAPI spec into Ajv
// This allows us to validate against any schema by name
for (const [name, schema] of Object.entries(openapiSpec.components.schemas)) {
  try {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  } catch (error) {
    console.error(`Failed to load schema ${name}:`, error);
  }
}

console.log(`[OpenAPI Validator] Loaded ${Object.keys(openapiSpec.components.schemas).length} schemas`);

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null;
  errorMessage?: string;
}

/**
 * Validate data against an OpenAPI component schema
 *
 * @param schemaName - Name of the schema in components/schemas (e.g., "CreateAnnotationRequest")
 * @param data - The data to validate
 * @returns Validation result with errors if invalid
 *
 * @example
 * const result = validateSchema('CreateAnnotationRequest', requestBody);
 * if (!result.valid) {
 *   return res.status(400).json({ error: result.errorMessage, details: result.errors });
 * }
 */
export function validateSchema(schemaName: string, data: unknown): ValidationResult {
  const validate = ajv.getSchema(`#/components/schemas/${schemaName}`);

  if (!validate) {
    console.error(`[OpenAPI Validator] Schema not found: ${schemaName}`);
    console.error(`[OpenAPI Validator] Available schemas:`, Object.keys(openapiSpec.components.schemas));
    return {
      valid: false,
      errors: null,
      errorMessage: `Schema ${schemaName} not found in OpenAPI spec`,
    };
  }

  const valid = validate(data);

  if (!valid) {
    const errorMessage = formatValidationErrors(validate.errors || []);
    return {
      valid: false,
      errors: validate.errors || null,
      errorMessage,
    };
  }

  return {
    valid: true,
    errors: null,
  };
}

/**
 * Format Ajv validation errors into a human-readable message
 */
function formatValidationErrors(errors: ErrorObject[]): string {
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

    return `${path}: ${message}`;
  });

  return messages.join('; ');
}

/**
 * Get the OpenAPI schema for a component (for debugging/inspection)
 */
export function getSchema(schemaName: string): unknown {
  return (openapiSpec.components.schemas as Record<string, unknown>)[schemaName];
}

/**
 * List all available schema names
 */
export function listSchemas(): string[] {
  return Object.keys(openapiSpec.components.schemas);
}
