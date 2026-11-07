/**
 * What a registry keeps in its storage, as protocol/specs/src/session/stored.json
 * states it: every key this SDK writes by hand, the key of a knowledge base's
 * session, the keys of what a session keeps of its stream and its queries, the
 * members of a stored session, the members of a resource open in a
 * knowledge base, the queries kept across a restart, the key of one per
 * nothing, and the members and the version of a kept query's document. A key
 * or a member the table gains, or a change in what it requires, fails here
 * until this SDK has it. oauth.test.ts holds a pending sign-in's members;
 * cache-cases.test.ts what a load keeps of a document and of `lastEventIds`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { filter, firstValueFrom } from 'rxjs';
import { isObject, resourceId } from '@semiont/core';
import { validators } from '@semiont/core/openapi';
import { KEPT_QUERIES, WHOLE_KEY, coupledLastEventId, keptPersister } from '../../cache-persister';
import { createTestSession } from '../../testing';
import { PENDING_AUTHORIZATION_KEY } from '../oauth';
import { SemiontBrowser } from '../semiont-browser';
import { InMemorySessionStorage } from '../session-storage';
import {
  ACTIVE_KEY,
  LAST_VIEWED_RESOURCE_BY_KB_KEY,
  OPEN_RESOURCES_BY_KB_KEY,
  STORAGE_KEY,
  cacheKey,
  getStoredSession,
  lastEventIdKey,
  sessionKey,
  setStoredSession,
  type StoredSession,
} from '../storage';

interface StoredTable {
  keys: { member: string; key: string }[];
  sessionKeyPrefix: { prefix: string };
  lastEventIdKeyPrefix: { prefix: string };
  cacheKeyPrefix: { prefix: string };
  storedSession: { properties: Record<string, unknown>; required: string[] };
  openResource: { properties: Record<string, unknown>; required: string[] };
  keptQueries: { query: string }[];
  wholeKey: { key: string };
  cacheDocument: { properties: { version: { const: number } } & Record<string, unknown> };
  lastEventIds: { propertyNames: { $ref: string }; additionalProperties: { $ref: string } };
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../protocol/specs/src/session/stored.json');
const table = JSON.parse(readFileSync(TABLE, 'utf-8')) as StoredTable;
const members = Object.keys(table.storedSession.properties);

/** Each key's constant here, by the name the table gives it. */
const KEYS: Record<string, string> = {
  knowledgeBasesKey: STORAGE_KEY,
  activeKey: ACTIVE_KEY,
  openResourcesByKbKey: OPEN_RESOURCES_BY_KB_KEY,
  lastViewedResourceByKbKey: LAST_VIEWED_RESOURCE_BY_KB_KEY,
  pendingAuthorizationKey: PENDING_AUTHORIZATION_KEY,
};

/**
 * What a registry with its knowledge base live writes under the open
 * resources key when one resource is opened with a media type and a place in
 * the working tree and another with neither: each written entry, by its id.
 */
async function writtenOpenResources(): Promise<Record<string, object>> {
  const kb = {
    id: 'kb-a',
    label: 'KB A',
    did: 'did:web:example.github.io:kb-a',
    endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
  };
  const { session, storage } = createTestSession({ kb });
  storage.set(STORAGE_KEY, JSON.stringify([kb]));
  storage.set(ACTIVE_KEY, kb.id);
  const browser = new SemiontBrowser({ storage, sessionFactory: () => session });
  await firstValueFrom(browser.activeSession$.pipe(filter((live) => live !== null)));

  browser.addOpenResource(resourceId('whole'), 'Whole', 'text/markdown', 'file://docs/whole.md');
  browser.addOpenResource(resourceId('bare'), 'Bare');
  const kept = storage.get(OPEN_RESOURCES_BY_KB_KEY);
  await browser.dispose();

  if (kept === null) throw new Error(`Nothing was written under ${OPEN_RESOURCES_BY_KB_KEY}`);
  const byKb = JSON.parse(kept) as Record<string, { id: string }[]>;
  return Object.fromEntries(byKb[kb.id].map((entry) => [entry.id, entry]));
}

/** What was written under `key`, as JSON. */
function writtenUnder(storage: InMemorySessionStorage, key: string): Record<string, unknown> {
  const text = storage.get(key);
  if (text === null) throw new Error(`Nothing was written under ${key}`);
  const written: unknown = JSON.parse(text);
  if (!isObject(written)) throw new Error(`What was written under ${key} is no object: ${text}`);
  return written;
}

/** A component's name among the validators; the namespace's `default` is the module itself. */
const isComponent = (name: string): name is Exclude<keyof typeof validators, 'default'> =>
  name !== 'default' && Object.hasOwn(validators, name);

/** The validator of the component a `$ref` of the table names. */
function validatorOf(ref: string): (value: unknown) => boolean {
  const component = /^\.\.\/components\/schemas\/([A-Za-z0-9]+)\.json$/.exec(ref)?.[1];
  if (component === undefined || !isComponent(component)) throw new Error(`${ref} names no component`);
  return validators[component];
}

/** A stored value with every member the table names but `left`. */
const storedWithout = (left: string): string =>
  JSON.stringify(Object.fromEntries(members.filter((member) => member !== left).map((member) => [member, `the ${member}`])));

describe('what a registry keeps, as protocol/specs/src/session/stored.json states it', () => {
  it("each key is the table's, and the table has none this SDK lacks", () => {
    expect(Object.fromEntries(table.keys.map(({ member, key }) => [member, key]))).toEqual(KEYS);
  });

  it("a knowledge base's session is kept under the table's prefix and its id", () => {
    expect(sessionKey('kb-a')).toBe(`${table.sessionKeyPrefix.prefix}kb-a`);
  });

  it("where a knowledge base's stream was is kept under the table's prefix and its id", () => {
    expect(lastEventIdKey('kb-a')).toBe(`${table.lastEventIdKeyPrefix.prefix}kb-a`);
  });

  it("a kept query is kept under the table's prefix, its persistence's key prefix and its name", () => {
    expect(cacheKey('kb-a', 'resource')).toBe(`${table.cacheKeyPrefix.prefix}kb-a.resource`);
  });

  it("a stored session is written with the table's members, and no others", () => {
    const whole: StoredSession = {
      access: 'a',
      refresh: 'r',
      clientId: 'semiont-browser',
      tokenEndpoint: 'https://issuer.test/token',
      revocationEndpoint: 'https://issuer.test/revoke',
    };
    const storage = new InMemorySessionStorage();
    setStoredSession(storage, 'kb-a', whole);
    const written = JSON.parse(storage.get(sessionKey('kb-a')) ?? 'null') as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([...members].sort());
  });

  it.each(members)('a stored value without %s is a session only if the table does not require it', (member) => {
    const storage = new InMemorySessionStorage();
    storage.set(sessionKey('kb-a'), storedWithout(member));
    const read = getStoredSession(storage, 'kb-a');
    if (table.storedSession.required.includes(member)) {
      expect(read).toBeNull();
    } else {
      expect(read).not.toBeNull();
    }
  });

  it("an open resource is written with the table's members, and no others", async () => {
    const { whole } = await writtenOpenResources();
    expect(Object.keys(whole).sort()).toEqual(Object.keys(table.openResource.properties).sort());
  });

  it('an open resource with no media type and no place in the tree is written with the members the table requires, and no others', async () => {
    const { bare } = await writtenOpenResources();
    expect(Object.keys(bare).sort()).toEqual([...table.openResource.required].sort());
  });

  it("the queries kept across a restart are the table's, and none other", () => {
    expect(Object.keys(KEPT_QUERIES).sort()).toEqual(table.keptQueries.map(({ query }) => query).sort());
  });

  it("a kept query per nothing keeps its one entry under the table's whole key", () => {
    expect(WHOLE_KEY).toBe(table.wholeKey.key);
  });

  it("a kept query's document is written with the table's members and version, and no others", () => {
    const storage = new InMemorySessionStorage();
    keptPersister('entityTypes', { storage, keyPrefix: 'kb-a' }).save(new Map([[WHOLE_KEY, ['Person']]]));
    const written = writtenUnder(storage, cacheKey('kb-a', 'entityTypes'));
    expect(Object.keys(written).sort()).toEqual(Object.keys(table.cacheDocument.properties).sort());
    expect(written['version']).toBe(table.cacheDocument.properties.version.const);
  });

  it("the stream's places are written as the table's lastEventIds", () => {
    const storage = new InMemorySessionStorage();
    const coupled = coupledLastEventId(storage, lastEventIdKey('kb-a'));
    coupled.saveLastEventId(resourceId('res-1'), 'p-res-1-47');
    coupled.storage.set(cacheKey('kb-a', 'resource'), '{}');
    const written = writtenUnder(storage, lastEventIdKey('kb-a'));
    const scope = validatorOf(table.lastEventIds.propertyNames.$ref);
    const place = validatorOf(table.lastEventIds.additionalProperties.$ref);
    expect(Object.keys(written)).toEqual(['res-1']);
    for (const [key, value] of Object.entries(written)) {
      expect(scope(key), `the scope ${key}`).toBe(true);
      expect(place(value), `the place of ${key}`).toBe(true);
    }
  });
});
