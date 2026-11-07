// The queries a client keeps across a restart: those protocol/specs/src/client/refresh.json marks `persisted`,
// as cache-refresh-table.mjs reads them, with what each is keyed by, and protocol/specs/src/session/stored.json's
// `wholeKey` and `cacheDocument` version. Every generator and gate that reads the kept queries reads them here,
// so what a kept query is keyed by and what it keeps is decided once.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCacheRefresh, WAY_ENDS } from './cache-refresh-table.mjs';

/** What a query per nothing keys its one entry by: stored.json's `wholeKey`. */
export const WHOLE = 'whole';

/**
 * Each kept query, in the table's order: its name; what its entries are keyed by (`ResourceId`,
 * `AnnotationId` or `WHOLE`); the component its value is; and the members within that component the
 * value is, outermost first (none when it is the component). With them, `wholeKey`'s key and
 * `cacheDocument`'s version. `refuse` is told what is wrong, and does not return.
 */
export function readKeptQueries(root, refuse) {
  const { queries, values } = readCacheRefresh(root, resolve(root, 'protocol/specs/src/client/refresh.json'), refuse);
  const kept = queries
    .filter((query) => query.persisted === true)
    .map((query) => ({ query: query.name, key: query.per === undefined ? WHOLE : WAY_ENDS[query.per], ...values.get(query.name) }));
  if (kept.length === 0) refuse('client/refresh.json marks no query persisted');
  const stored = JSON.parse(readFileSync(resolve(root, 'protocol/specs/src/session/stored.json'), 'utf8'));
  if (typeof stored.wholeKey?.key !== 'string') refuse('stored.json states no wholeKey');
  const version = stored.cacheDocument?.properties?.version?.const;
  if (!Number.isInteger(version)) refuse("stored.json's cacheDocument states no version");
  return { kept, wholeKey: stored.wholeKey.key, version };
}
