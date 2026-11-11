/**
 * The cache case table states the spec's rule: protocol/specs/src/session/cache-cases.json, held to the
 * queries protocol/specs/src/client/refresh.json marks `persisted` and to
 * protocol/specs/src/session/stored.json's `wholeKey`, `cacheDocument` and `lastEventIds`.
 *
 * Every SDK runs the table against its own persister, so a case whose expectation is not the spec's
 * would hold every SDK to a wrong rule. Here each expectation is derived from the spec alone: a
 * document's structure by stored.json's own `cacheDocument`, each key by the query's `per` and each
 * value by its `value` in refresh.json. A load keeps exactly the entries whose key and value both hold,
 * of a document whose structure holds; a load of places keeps exactly the pairs of a resource's id and
 * a PersistedEventId. A refused write writes, once the storage takes it, what a write does.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { validators } from '../openapi';

interface Kept {
  query: string;
  key: string;
  component: string;
  /** The members within the component the value is, outermost first; none when it is the component. */
  members: string[];
}

type ReadKeptQueries = (root: string, refuse: (message: string) => never) => { kept: Kept[]; wholeKey: string; version: number };

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const { readKeptQueries, WHOLE }: { readKeptQueries: ReadKeptQueries; WHOLE: string } = await import(
  fileURLToPath(new URL('../../../../codegen/schemas/kept-queries.mjs', import.meta.url))
);

type Entry = [unknown, unknown];

interface Stored {
  name: string;
  stored?: unknown;
  storedText?: string;
}

interface Load extends Stored {
  query: string;
  kept: Entry[];
}

interface Write {
  name: string;
  query: string;
  held: Entry[];
  written: { version: number; entries: Entry[] };
}

interface Places extends Stored {
  kept: Record<string, string>;
}

const read = (path: string): unknown => JSON.parse(readFileSync(`${ROOT}/${path}`, 'utf8'));
const table = read('protocol/specs/src/session/cache-cases.json') as { cases: Load[]; writes: Write[]; refusedWrites: Write[]; places: Places[] };
const stored = read('protocol/specs/src/session/stored.json') as { cacheDocument: object };

const { kept, wholeKey } = readKeptQueries(ROOT, (message) => {
  throw new Error(message);
});
const keptBy = new Map(kept.map((query) => [query.query, query]));

/** A component's name among the validators; the namespace's `default` is the module itself. */
const isComponent = (name: string): name is Exclude<keyof typeof validators, 'default'> =>
  name !== 'default' && Object.hasOwn(validators, name);

const holds = (component: string, value: unknown): boolean => {
  if (!isComponent(component)) throw new Error(`${component} has no validator`);
  return validators[component](value) === true;
};

const keyHolds = (query: Kept, key: unknown): boolean => (query.key === WHOLE ? key === wholeKey : holds(query.key, key));
/** A value held as its component holding it alone, member within member. */
const valueHolds = (query: Kept, value: unknown): boolean =>
  holds(query.component, query.members.reduceRight<unknown>((inner, member) => ({ [member]: inner }), value));

const structureHolds = new Ajv2020({ strict: false }).compile(stored.cacheDocument);

/** The text a case keeps under its key. */
const text = (stated: Stored): string => {
  if ((stated.stored === undefined) === (stated.storedText === undefined)) throw new Error(`${stated.name}: states not exactly one of stored and storedText`);
  return stated.storedText ?? JSON.stringify(stated.stored);
};

const parsed = (source: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return { ok: false };
  }
};

/** What a load of a query's document keeps, by the spec's rule. */
function loaded(query: Kept, source: string): Entry[] {
  const document = parsed(source);
  if (!document.ok || !structureHolds(document.value)) return [];
  const { entries } = document.value as { entries: [unknown, unknown, number][] };
  return entries.filter(([key, value]) => keyHolds(query, key) && valueHolds(query, value)).map(([key, value]) => [key, value]);
}

/** What a load of places keeps, by the spec's rule. */
function placesLoaded(source: string): Record<string, string> {
  const places = parsed(source);
  if (!places.ok || typeof places.value !== 'object' || places.value === null || Array.isArray(places.value)) return {};
  return Object.fromEntries(
    Object.entries(places.value).filter(([scope, place]) => holds('ResourceId', scope) && holds('PersistedEventId', place)),
  );
}

const asMap = (entries: Entry[]): Map<string, unknown> => new Map(entries.map(([key, value]) => [JSON.stringify(key), value]));

describe('the cache case table (protocol/specs/src/session/cache-cases.json)', () => {
  it('keeps every query refresh.json marks persisted, and no other', () => {
    expect(new Set(table.cases.map((stated) => stated.query))).toEqual(new Set(keptBy.keys()));
    expect(new Set(table.writes.map((stated) => stated.query))).toEqual(new Set(keptBy.keys()));
  });

  it.each(table.cases)('$name: keeps what the spec keeps', (stated) => {
    const query = keptBy.get(stated.query);
    if (query === undefined) throw new Error(`${stated.name}: ${stated.query} is no kept query`);
    expect(asMap(stated.kept)).toEqual(asMap(loaded(query, text(stated))));
  });

  it.each([...table.writes, ...table.refusedWrites])('$name: writes what it holds, each key and value the query\'s', (stated) => {
    const query = keptBy.get(stated.query);
    if (query === undefined) throw new Error(`${stated.name}: ${stated.query} is no kept query`);
    for (const [key, value] of stated.held) {
      expect(keyHolds(query, key), `${stated.name}: key ${JSON.stringify(key)}`).toBe(true);
      expect(valueHolds(query, value), `${stated.name}: the value of ${JSON.stringify(key)}`).toBe(true);
    }
    const stamped = { ...stated.written, entries: stated.written.entries.map(([key, value]) => [key, value, 0]) };
    expect(structureHolds(stamped)).toBe(true);
    expect(asMap(stated.written.entries)).toEqual(asMap(stated.held));
  });

  it.each(table.places)('$name: keeps the places the spec keeps', (stated) => {
    expect(stated.kept).toEqual(placesLoaded(text(stated)));
  });
});
