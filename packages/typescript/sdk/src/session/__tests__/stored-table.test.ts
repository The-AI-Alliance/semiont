/**
 * What a registry keeps in its storage, as protocol/specs/src/session/stored.json
 * states it: every key this SDK writes by hand, the key of a knowledge base's
 * session, the keys of what a session keeps of its stream and its queries for
 * one person, each as the table's example works it out, and the members of a
 * stored session. A key or a member the table gains fails here until this SDK
 * has it. oauth.test.ts holds a pending sign-in's members, and
 * persisted-cases.test.ts every key a person's client keeps.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PERSISTED_QUERIES } from '@semiont/core';
import { PENDING_AUTHORIZATION_KEY } from '../oauth';
import { InMemorySessionStorage } from '../session-storage';
import {
  ACTIVE_KEY,
  LAST_VIEWED_RESOURCE_BY_KB_KEY,
  OPEN_RESOURCES_BY_KB_KEY,
  STORAGE_KEY,
  cacheKey,
  getStoredSession,
  lastEventIdKey,
  personKey,
  sessionKey,
  setStoredSession,
  type StoredSession,
} from '../storage';

/** One key worked out: from a knowledge base's id, a person's did and, for a query, its name. */
interface Example {
  kbId: string;
  did: string;
  key: string;
}

interface StoredTable {
  keys: { member: string; key: string }[];
  sessionKeyPrefix: { prefix: string };
  lastEventIdKeyPrefix: { prefix: string; example: Example };
  cacheKeyPrefix: { prefix: string; example: Example & { query: string } };
  storedSession: { properties: Record<string, unknown>; required: string[] };
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

  it("where a knowledge base's stream was, for one person, is kept under the key the table's example works out", () => {
    const { prefix, example } = table.lastEventIdKeyPrefix;
    const key = lastEventIdKey(example.kbId, personKey(example.did));
    expect(key).toBe(example.key);
    expect(key.startsWith(`${prefix}${example.kbId}.`)).toBe(true);
  });

  it("a kept query, for one person, is kept under the key the table's example works out", () => {
    const { prefix, example } = table.cacheKeyPrefix;
    const query = PERSISTED_QUERIES.find((persisted) => persisted === example.query);
    if (query === undefined) throw new Error(`the table's example keeps ${example.query}, which refresh.json does not mark persisted`);
    const key = cacheKey(example.kbId, personKey(example.did), query);
    expect(key).toBe(example.key);
    expect(key.startsWith(`${prefix}${example.kbId}.`)).toBe(true);
  });

  const whole: StoredSession = {
    access: 'a',
    refresh: 'r',
    clientId: 'semiont-browser',
    tokenEndpoint: 'https://issuer.test/token',
    revocationEndpoint: 'https://issuer.test/revoke',
    personKey: 'gqB898gk4Ww_orAHhzDCSVl7yHP9UEsX0DA_xbGbq-I',
  };

  it("a stored session is written with the table's members, and no others", () => {
    const storage = new InMemorySessionStorage();
    setStoredSession(storage, 'kb-a', whole);
    const written = JSON.parse(storage.get(sessionKey('kb-a')) ?? 'null') as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([...members].sort());
  });

  it('a stored session is read back with every member it was written with', () => {
    const storage = new InMemorySessionStorage();
    storage.set(sessionKey('kb-a'), JSON.stringify(whole));
    expect(getStoredSession(storage, 'kb-a')).toEqual(whole);
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
});
