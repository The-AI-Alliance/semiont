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
  // Non-empty, not merely present (GENERATION-OUTPUT-FORMAT D9/D9b): the
  // worker has no fallback, so `storageUri: ''` would write to a bare
  // `file://` and `title: ''` would name the resource nothing. This guard is
  // the ONLY runtime enforcement — `JobCreateCommand.params` is
  // `additionalProperties: true`, so /bus/emit's generated validator never
  // sees these fields.
  return (
    typeof value.title === 'string' && value.title.length > 0
    && typeof value.storageUri === 'string' && value.storageUri.length > 0
    && isObject(value.context)
  );
}

/**
 * Boundary guard for a `GatheredContext` whose type history was severed —
 * today that is exactly one place: the wizard stashes the context in
 * `sessionStorage` on the way to the compose page, which reads it back and
 * `JSON.parse`s it.
 *
 * Checks what consumers actually dereference rather than the whole schema:
 * `focus` (every view branches on `focus.kind`) and `graph.nodes` / `graph.edges`,
 * which `deriveViews` maps over without a guard. Both are `required` in
 * `GatheredContext.json` / `KnowledgeGraph.json`, so this is dead code for every
 * well-typed caller — the price of a trust boundary, same as
 * `isGenerationJobParams` above.
 *
 * The failure it prevents is not cosmetic: `deriveViews` runs during render, so a
 * stale stash (a tab held open across a deploy) throws inside React rather than
 * degrading, unmounting the flow to the nearest error boundary.
 */
export function isGatheredContext(
  value: unknown,
): value is import('./payload-types').GatheredContext {
  if (!isObject(value)) return false;
  if (!isObject(value.focus)) return false;
  if (!isObject(value.graph)) return false;
  return isArray(value.graph.nodes) && isArray(value.graph.edges);
}
