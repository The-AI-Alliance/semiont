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
 * Whether a completed job's stored result is one its worker reported
 * (`JobStoredResult`): a job completed without a result is stored with an
 * empty one, and every `JobResult` requires a member.
 */
export function isReportedJobResult(
  result: import('./types').components['schemas']['JobStoredResult'] | undefined,
): result is import('./types').components['schemas']['JobResult'] {
  return result !== undefined && Object.keys(result).length > 0;
}

/**
 * Whether a job's result is one a `mark` job reports (`MarkJobResult`): its
 * counts, or a decline.
 *
 * A stored result is any verb's (`JobResult`), and its members share no
 * member of their own (the spec's job gate holds that). So the one result a
 * `mark` job never reports is told by a member only it has, and what is left
 * is held to `MarkJobResult` by the compiler: a result added to `JobResult`
 * does not pass here unseen.
 */
export function isMarkJobResult(
  result: import('./payload-types').JobResult,
): result is import('./payload-types').MarkJobResult {
  if ('resourceId' in result) return false;
  result satisfies import('./payload-types').MarkJobResult;
  return true;
}

/**
 * Whether a job's result is one a `yield` job reports (`YieldJobResult`): the
 * resource it made, or a decline. Told as `isMarkJobResult` tells its own.
 */
export function isYieldJobResult(
  result: import('./payload-types').JobResult,
): result is import('./payload-types').YieldJobResult {
  if ('found' in result) return false;
  result satisfies import('./payload-types').YieldJobResult;
  return true;
}
