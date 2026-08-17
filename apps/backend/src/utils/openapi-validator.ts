/**
 * OpenAPI Schema Validator
 *
 * Validates data against OpenAPI component schemas using Ajv (JSON Schema validator).
 * This enables spec-first architecture where openapi.json is the source of truth.
 */

import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import openapiSpec from '../../../../specs/openapi.json';
import { getLogger } from '../logger';

// Lazy initialization to avoid calling getLogger() at module load time
const getValidatorLogger = () => getLogger().child({ component: 'openapi-validator' });

// Initialize Ajv with OpenAPI-compatible settings
const ajv = new Ajv({
  allErrors: true,      // Return all errors, not just the first one
  coerceTypes: true,    // Coerce types (e.g., "123" -> 123)
  removeAdditional: false, // Don't remove additional properties
  // Allow OpenAPI's annotation-only keywords (no validation semantics).
  // "discriminator" stays annotation-only deliberately: the sibling oneOf is
  // the validation authority, and Ajv's own `discriminator: true` option
  // rejects the explicit `mapping` our discriminated unions declare.
  keywords: ['example', 'discriminator'],
});

// Add format validators (email, uri, date-time, etc.)
addFormats(ajv);

/**
 * Convert OpenAPI 3.0 `nullable: true` to JSON Schema draft-07, which Ajv
 * expects. Mutates the object in place (operates on a deep clone).
 *
 * Two 3.0 idioms to cover: `nullable` beside a string `type` becomes
 * `type: [original, "null"]`, and `nullable` beside `allOf` — 3.0's only way
 * to express a nullable `$ref`, since a bare `$ref` takes no siblings —
 * becomes `anyOf: [{type: "null"}, <the rest>]`. Leaving either in place is
 * not an option: strict-mode Ajv refuses the keyword at compile time, which
 * surfaces as a 500 on the first request through that schema.
 */
function convertNullable(obj: unknown): void {
  if (obj === null || obj === undefined || typeof obj !== 'object') return;
  const record = obj as Record<string, unknown>;
  if (record.nullable === true) {
    delete record.nullable;
    if (typeof record.type === 'string') {
      record.type = [record.type, 'null'];
    } else {
      const inner: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        inner[key] = record[key];
        delete record[key];
      }
      record.anyOf = [{ type: 'null' }, inner];
    }
  }
  for (const v of Object.values(record)) {
    if (typeof v === 'object') convertNullable(v);
  }
}

// Lazy initialization flag to ensure schemas are loaded only once
let schemasLoaded = false;

/**
 * Load all schemas from OpenAPI spec into Ajv
 * This is called lazily on first validation to avoid logger initialization issues
 */
function loadSchemas(): void {
  if (schemasLoaded) return;

  for (const [name, schema] of Object.entries(openapiSpec.components.schemas)) {
    try {
      const converted = structuredClone(schema);
      convertNullable(converted);
      ajv.addSchema(converted, `#/components/schemas/${name}`);
    } catch (error) {
      getValidatorLogger().error('Failed to load schema', {
        schemaName: name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  getValidatorLogger().info('OpenAPI schemas loaded', {
    count: Object.keys(openapiSpec.components.schemas).length
  });

  schemasLoaded = true;
}

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
  // Ensure schemas are loaded before validation
  loadSchemas();

  const validate = ajv.getSchema(`#/components/schemas/${schemaName}`);

  if (!validate) {
    getValidatorLogger().error('Schema not found', {
      schemaName,
      availableSchemas: Object.keys(openapiSpec.components.schemas)
    });
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
