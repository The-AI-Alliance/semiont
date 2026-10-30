/**
 * What a registry keeps in its storage, as specs/src/session/stored.json
 * states it: every key this SDK writes by hand, the key of a knowledge base's
 * session, and the members of a stored session. A key or a member the table
 * gains fails here until this SDK has it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PENDING_AUTHORIZATION_KEY } from '../oauth';
import { InMemorySessionStorage } from '../session-storage';
import {
  ACTIVE_KEY,
  LAST_VIEWED_RESOURCE_BY_KB_KEY,
  OPEN_RESOURCES_BY_KB_KEY,
  STORAGE_KEY,
  getStoredSession,
  sessionKey,
  setStoredSession,
  type StoredSession,
} from '../storage';

interface StoredTable {
  keys: { member: string; key: string }[];
  sessionKeyPrefix: { prefix: string };
  storedSession: { properties: Record<string, unknown>; required: string[] };
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../specs/src/session/stored.json');
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

describe('what a registry keeps, as specs/src/session/stored.json states it', () => {
  it("each key is the table's, and the table has none this SDK lacks", () => {
    expect(Object.fromEntries(table.keys.map(({ member, key }) => [member, key]))).toEqual(KEYS);
  });

  it("a knowledge base's session is kept under the table's prefix and its id", () => {
    expect(sessionKey('kb-a')).toBe(`${table.sessionKeyPrefix.prefix}kb-a`);
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
});
