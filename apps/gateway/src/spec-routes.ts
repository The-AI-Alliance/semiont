/**
 * The gateway serves exactly the operations its spec declares: no route the
 * spec does not name, and no declared operation without one.
 *
 * The conformance suite probes every operation the spec declares, from
 * outside; a route registered in code and missing from the spec is invisible
 * to it. The route table is whole only once the app is assembled, so the
 * gateway compares the two there, at boot, and refuses to serve when they
 * differ. A new route is declared in `specs/src` first.
 */
import { isObject } from '@semiont/core';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/** A path's shape, parameter names aside: Hono's `:id` and OpenAPI's `{id}` both become `{}`. */
const shape = (path: string) => path.replace(/:[^/]+/g, '{}').replace(/\{[^}]+\}/g, '{}');

/**
 * Every difference between the routes the app registered and the operations
 * `paths` (the spec's) declares. Middleware (`use`, registered for every
 * method) is not an operation; it applies under a wildcard or to a path the
 * spec declares.
 */
export function routeMismatches(routes: ReadonlyArray<{ method: string; path: string }>, paths: Record<string, unknown>): string[] {
  const declared = new Set<string>();
  const declaredPaths = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    declaredPaths.add(shape(path));
    if (!isObject(item)) continue;
    for (const method of Object.keys(item)) if (HTTP_METHODS.has(method)) declared.add(`${method.toUpperCase()} ${shape(path)}`);
  }

  const problems = new Set<string>();
  const served = new Set<string>();
  for (const { method, path } of routes) {
    if (method === 'ALL') {
      if (!path.includes('*') && !declaredPaths.has(shape(path))) problems.add(`${path} is registered for every method, and the spec declares no such path`);
      continue;
    }
    const operation = `${method} ${shape(path)}`;
    served.add(operation);
    if (!declared.has(operation)) problems.add(`${method} ${path} is served, and the spec does not declare it`);
  }
  for (const operation of declared) if (!served.has(operation)) problems.add(`${operation} is declared, and nothing serves it`);
  return [...problems];
}
