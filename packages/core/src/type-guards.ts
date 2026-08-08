/**
 * Common type guard utilities
 */

/**
 * Check if value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Check if value is a number (not NaN)
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/**
 * Check if value is an object (not null, not array)
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if value is an array
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Check if value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Check if value is a function
 */
export function isFunction(value: unknown): value is Function {
  return typeof value === 'function';
}

/**
 * Check if value is null
 */
export function isNull(value: unknown): value is null {
  return value === null;
}

/**
 * Check if value is undefined
 */
export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

/**
 * Check if value is null or undefined
 */
export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Check if value is defined (not null or undefined)
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Boundary guard for `job:create` generation params (YIELD-FROM-CONTEXT P1).
 *
 * Checks the REQUIRED trio the schema declares (`title`, `storageUri`,
 * `context`) plus basic shape — deliberately NOT a full schema validation
 * (that depth belongs to the spec and its generated types); this is the
 * runtime half of the contract for values whose type history was severed:
 * wire JSON, storage, casts. For well-typed callers it is dead code, and
 * that is the correct price for a trust-boundary check.
 */
export function isGenerationJobParams(
  value: unknown,
): value is import('./payload-types').GenerationJobParams {
  if (!isObject(value)) return false;
  return (
    typeof value.title === 'string'
    && typeof value.storageUri === 'string'
    && isObject(value.context)
  );
}
