// The queries a client keeps across a restart: protocol/specs/src/session/stored.json's `keptQueries`, each
// held to protocol/specs/src/client/refresh.json's queries and to the component its value names. Every
// generator and gate that reads them reads them here, so what a kept query is keyed by and what it keeps is
// decided once.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** What a query per nothing keys its one entry by: stored.json's `wholeKey`. */
export const WHOLE = 'whole';

/** What a query's `per` keys its entries by. A query per filters is not kept. */
const KEYED_BY = { resource: 'ResourceId', annotation: 'AnnotationId' };

const VALUE = /^\.\.\/components\/schemas\/([A-Za-z0-9]+)\.json(?:#\/properties\/([A-Za-z0-9]+))?$/;

/**
 * Each kept query, in the table's order: its name; what its entries are keyed by (`ResourceId`,
 * `AnnotationId` or `WHOLE`); the component its value is; and, where its value is one member of that
 * component, the member. With them, `wholeKey`'s key and `cacheDocument`'s version. `refuse` is told
 * what is wrong, and does not return.
 */
export function readKeptQueries(root, refuse) {
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const stored = read('protocol/specs/src/session/stored.json');
  const queries = new Map(read('protocol/specs/src/client/refresh.json').queries.map((query) => [query.name, query]));
  if (!Array.isArray(stored.keptQueries) || stored.keptQueries.length === 0) refuse('stored.json states no keptQueries');
  const kept = stored.keptQueries.map((row, i) => {
    const label = `keptQueries[${i}]`;
    const query = queries.get(row.query);
    if (query === undefined) refuse(`${label}: ${row.query} is no query of client/refresh.json`);
    if (query.per !== undefined && !(query.per in KEYED_BY)) refuse(`${label}: ${row.query} is per ${query.per}, and a query per ${query.per} is not kept`);
    const match = VALUE.exec(row.value?.$ref);
    if (match === null || Object.keys(row.value).length !== 1) {
      refuse(`${label}: value is ${JSON.stringify(row.value)}, not a $ref to a component or to one member of one`);
    }
    const [, component, member] = match;
    const file = `protocol/specs/src/components/schemas/${component}.json`;
    if (!existsSync(resolve(root, file))) refuse(`${label}: ${component} is no component`);
    if (member !== undefined) {
      const schema = read(file);
      if (schema.properties?.[member] === undefined) refuse(`${label}: ${component} has no member ${member}`);
      // The member is checked as the component holding it alone, which is exact only when it is all the component requires.
      if (JSON.stringify(schema.required) !== JSON.stringify([member])) {
        refuse(`${label}: ${component} requires ${JSON.stringify(schema.required)}, so ${member} alone is not one of it`);
      }
    }
    return { query: row.query, key: query.per === undefined ? WHOLE : KEYED_BY[query.per], component, member };
  });
  if (new Set(kept.map(({ query }) => query)).size !== kept.length) refuse('keptQueries names a query twice');
  if (typeof stored.wholeKey?.key !== 'string') refuse('stored.json states no wholeKey');
  const version = stored.cacheDocument?.properties?.version?.const;
  if (!Number.isInteger(version)) refuse("stored.json's cacheDocument states no version");
  return { kept, wholeKey: stored.wholeKey.key, version };
}
