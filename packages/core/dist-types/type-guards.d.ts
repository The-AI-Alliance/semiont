/**
 * Common type guard utilities
 */
/**
 * Check if value is a string
 */
export declare function isString(value: unknown): value is string;
/**
 * Check if value is a number (not NaN)
 */
export declare function isNumber(value: unknown): value is number;
/**
 * Check if value is an object (not null, not array)
 */
export declare function isObject(value: unknown): value is Record<string, unknown>;
/**
 * Check if value is an array
 */
export declare function isArray(value: unknown): value is unknown[];
/**
 * Check if value is a boolean
 */
export declare function isBoolean(value: unknown): value is boolean;
/**
 * Check if value is a function
 */
export declare function isFunction(value: unknown): value is Function;
/**
 * Check if value is null
 */
export declare function isNull(value: unknown): value is null;
/**
 * Check if value is undefined
 */
export declare function isUndefined(value: unknown): value is undefined;
/**
 * Check if value is null or undefined
 */
export declare function isNullish(value: unknown): value is null | undefined;
/**
 * Check if value is defined (not null or undefined)
 */
export declare function isDefined<T>(value: T | null | undefined): value is T;
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
export declare function isGenerationJobParams(value: unknown): value is import('./payload-types').GenerationJobParams;
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
export declare function isGatheredContext(value: unknown): value is import('./payload-types').GatheredContext;
