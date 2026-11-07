/**
 * protocol/specs/src/session/cache-cases.json, run through this SDK's own persisters: what a load keeps of a
 * kept query's document and of the stream's places, and what a save writes of what a query's cache holds.
 * Each case's query is found by its name in the table, so a query the spec keeps and this SDK does not
 * fails here. stored-table.test.ts holds the kept queries, the whole key and the document's members to
 * protocol/specs/src/session/stored.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isObject } from '@semiont/core';
import { createCache } from '../cache';
import { KEPT_QUERIES, coupledLastEventId, keptPersister, type KeptKey, type KeptQuery, type KeptValue } from '../cache-persister';
import { InMemorySessionStorage } from '../session/session-storage';
import { cacheKey, lastEventIdKey, personKey } from '../session/storage';

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

const TABLE = fileURLToPath(new URL('../../../../../protocol/specs/src/session/cache-cases.json', import.meta.url));
const table = JSON.parse(readFileSync(TABLE, 'utf8')) as { cases: Load[]; writes: Write[]; places: Places[] };

/** The knowledge base and the person each case's documents and places are kept for. */
const KEPT_FOR = { kbId: 'kb-cases', personKey: personKey('did:web:example.org:users:jo') };

const isKept = (name: string): name is KeptQuery => Object.hasOwn(KEPT_QUERIES, name);

function keptQuery(name: string): KeptQuery {
  if (!isKept(name)) throw new Error(`the table keeps ${name}, and this SDK keeps no ${name}`);
  return name;
}

/** The text a case keeps under its key. */
function text(stated: Stored): string {
  if ((stated.stored === undefined) === (stated.storedText === undefined)) throw new Error(`${stated.name}: states not exactly one of stored and storedText`);
  if (stated.storedText !== undefined) return stated.storedText;
  return JSON.stringify(stated.stored);
}

/** Entries by key, as the document writes each key: their order is no part of the rule. */
const asMap = (entries: Entry[]): Map<string, unknown> => new Map(entries.map(([key, value]) => [JSON.stringify(key), value]));

/** What a load of `query`'s document keeps of `source`. */
function loaded(query: KeptQuery, source: string): Entry[] {
  const storage = new InMemorySessionStorage();
  storage.set(cacheKey(KEPT_FOR.kbId, KEPT_FOR.personKey, query), source);
  const kept = keptPersister(query, { storage, ...KEPT_FOR }).load();
  return kept === null ? [] : [...kept];
}

/**
 * What a save writes once `query`'s cache holds `held`, by the cache's own path: each answer set into the
 * cache, and the cache disposed, which flushes the save it owes.
 */
function written<Q extends KeptQuery>(query: Q, held: Entry[]): unknown {
  const storage = new InMemorySessionStorage();
  const { key: isKey, value: isValue } = KEPT_QUERIES[query];
  const cache = createCache<KeptKey<Q>, KeptValue<Q>>(
    async (key) => {
      throw new Error(`a cache that is only written fetched ${key}`);
    },
    { persister: keptPersister(query, { storage, ...KEPT_FOR }) },
  );
  for (const [key, value] of held) {
    if (!isKey(key) || !isValue(value)) throw new Error(`${query} holds no ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    cache.set(key, value);
  }
  cache.dispose();
  const document = storage.get(cacheKey(KEPT_FOR.kbId, KEPT_FOR.personKey, query));
  if (document === null) throw new Error(`a save of ${query} wrote nothing`);
  return JSON.parse(document);
}

const isStamped = (entry: unknown): entry is [unknown, unknown, number] =>
  Array.isArray(entry) && entry.length === 3 && Number.isInteger(entry[2]) && entry[2] >= 0;

describe("the cache case table (protocol/specs/src/session/cache-cases.json), through this SDK's persisters", () => {
  it.each(table.cases)('$name: keeps what the table keeps', (stated) => {
    expect(asMap(loaded(keptQuery(stated.query), text(stated)))).toEqual(asMap(stated.kept));
  });

  it.each(table.writes)('$name: writes the document the table writes', (stated) => {
    const document = written(keptQuery(stated.query), stated.held);
    if (!isObject(document)) throw new Error(`${stated.name}: the save wrote ${JSON.stringify(document)}, which is no object`);
    expect(Object.keys(document).sort(), 'the members of the document').toEqual(Object.keys(stated.written).sort());
    expect(document['version']).toBe(stated.written.version);
    const entries = document['entries'];
    if (!Array.isArray(entries)) throw new Error(`${stated.name}: the save wrote entries ${JSON.stringify(entries)}, which are no list`);
    for (const entry of entries) expect(isStamped(entry), `${JSON.stringify(entry)} is a key, a value and a stamp of at least 0`).toBe(true);
    expect(asMap(entries.filter(isStamped).map(([key, value]): Entry => [key, value]))).toEqual(asMap(stated.written.entries));
  });

  it.each(table.places)('$name: keeps the places the table keeps', (stated) => {
    const storage = new InMemorySessionStorage();
    storage.set(lastEventIdKey(KEPT_FOR.kbId, KEPT_FOR.personKey), text(stated));
    const kept = coupledLastEventId(storage, lastEventIdKey(KEPT_FOR.kbId, KEPT_FOR.personKey)).loadLastEventIds();
    expect(kept === null ? {} : Object.fromEntries(kept)).toEqual(stated.kept);
  });
});
