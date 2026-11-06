/**
 * What a client keeps of one person, and when it is read, written and
 * deleted: one table, protocol/specs/src/session/persisted-cases.json, run by
 * every SDK.
 *
 * `keys` holds the key builders and the generated list of persisted queries,
 * and the client a registry's session makes to reading exactly those keys.
 * `forget` forgets kb-a's saved sign-in over a storage seeded as the table
 * says: by the registry's sign-out or removal, where an open knowledge base's
 * client is stood in for by one whose closing writes under jo's `resource`
 * key, as the table allows; or by the registry's own session expiring or
 * being refused, over a gateway and an issuer that answer as the row says.
 * `startup` and `crossTab` run the sessions the HTTP session factory makes —
 * what a registry's sessions are — over a gateway that is `fetch` and
 * nothing else (fake-gateway.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BehaviorSubject, filter, firstValueFrom, map, take } from 'rxjs';
import { PERSISTED_QUERIES, resourceId } from '@semiont/core';
import type { AccessToken, KnowledgeBase, components } from '@semiont/core';
import { isReady } from '../../cache';
import { createTestClient } from '../../testing';
import { createHttpSessionFactory } from '../http-session-factory';
import { SemiontBrowser } from '../semiont-browser';
import { SemiontSession } from '../semiont-session';
import { createSessionSignals } from '../session-signals';
import type { SessionFactory } from '../session-factory';
import type { SessionStorage } from '../session-storage';
import {
  ACTIVE_KEY,
  STORAGE_KEY,
  cacheKey,
  getStoredSession,
  lastEventIdKey,
  personKey,
  sessionKey,
} from '../storage';
import { fakeGateway, GATEWAY_ENDPOINT, refuses, renews, type FakeGateway, type StreamConnect } from './fake-gateway';
import { SharedStorage, freshJwt, testSession } from './test-storage-helpers';

type Kept = Readonly<Record<string, string>>;
type SignedIn = 'named' | 'unnamed' | 'none';
type Value = 'kept' | 'fresh';

interface Person {
  did: string;
  personKey: string;
}

interface KeysRow {
  why: string;
  kbId: string;
  did: string;
  personKey: string;
  lastEventIdKey: string;
  cacheKeys: Readonly<Record<string, string>>;
}

interface ForgetRow {
  why: string;
  by: 'signOut' | 'removal' | 'expiry' | 'refusal';
  /** For `expiry` and `refusal`: the token the session finds stored. */
  stored?: 'expired' | 'unexpired';
  signedIn: SignedIn;
  open: boolean;
  removes: 'person' | 'nothing';
}

interface StartupRow {
  why: string;
  signedIn: SignedIn;
  gateway: 'names' | 'unreachable';
  first: Value;
  then: Value;
  recorded: string | null;
  place: string | null;
  untouched?: boolean;
}

interface CrossTabRow {
  why: string;
  stored: { personKey: string | null } | null;
  saved: boolean;
}

interface PersistedCases {
  people: Readonly<Record<string, Person>>;
  keys: KeysRow[];
  forgetStorage: Kept;
  forget: ForgetRow[];
  whoAmI: components['schemas']['UserResponse'];
  startupStorage: Kept;
  startup: StartupRow[];
  crossTab: CrossTabRow[];
}

interface StoredTable {
  lastEventIdKeyPrefix: { prefix: string };
  cacheKeyPrefix: { prefix: string };
}

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../protocol/specs/src');
const table = JSON.parse(readFileSync(join(SPECS, 'session/persisted-cases.json'), 'utf-8')) as PersistedCases;
const stored = JSON.parse(readFileSync(join(SPECS, 'session/stored.json'), 'utf-8')) as StoredTable;

const personOf = (name: string): Person => {
  const person = table.people[name];
  if (person === undefined) throw new Error(`the table names no ${name}`);
  return person;
};
const jo = personOf('jo');

const kbNamed = (id: string): KnowledgeBase => ({ id, label: id, did: `did:web:kb.example.org:${id}`, endpoint: GATEWAY_ENDPOINT });
const KB_A = kbNamed('kb-a');
const KB_B = kbNamed('kb-b');

/** Every key a person's client keeps on a knowledge base: its stream's places, and each persisted query's. */
const keysOf = (kbId: string, person: string): string[] => [
  lastEventIdKey(kbId, person),
  ...PERSISTED_QUERIES.map((query) => cacheKey(kbId, person, query)),
];

const seed = (storage: SessionStorage, kept: Kept): void => {
  for (const [key, value] of Object.entries(kept)) storage.set(key, value);
};

/**
 * A knowledge base's stored sign-in as a row states it, holding `access`: one
 * naming `person`, one naming nobody, or none. Written as the JSON a
 * registry keeps.
 */
const storeSignIn = (storage: SessionStorage, kbId: string, signedIn: SignedIn, person: string, access: string): void => {
  if (signedIn === 'none') return;
  const signIn = testSession(access, 'refresh-1');
  storage.set(sessionKey(kbId), JSON.stringify(signedIn === 'named' ? { ...signIn, personKey: person } : signIn));
};

/** A gateway that names whom the table's `whoAmI` names once `release` is called, or cannot be asked. */
const heldGateway = (says: StartupRow['gateway']): { gateway: FakeGateway; release: () => void } => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = fakeGateway({
    whoIs: async () => {
      await released;
      if (says === 'unreachable') throw new TypeError('fetch failed');
      return Response.json(table.whoAmI);
    },
    issuer: renews,
    resourceName: 'fresh',
  });
  return { gateway, release };
};

/** A session of `kb` the HTTP session factory makes over `storage`, as a registry has it made. */
const sessionOver = (gateway: FakeGateway, kb: KnowledgeBase, storage: SessionStorage): SemiontSession =>
  createHttpSessionFactory(gateway.fetch)({ kb, storage, signals: createSessionSignals(), onError: () => {} });

const end = (session: SemiontSession, gateway: FakeGateway): void => {
  session.dispose();
  session.client.dispose();
  gateway.close();
};

/** The name of the first value the client gives for `id`. */
const firstName = (session: SemiontSession, id: string): Promise<string> =>
  firstValueFrom(session.client.browse.resource(resourceId(id)).pipe(filter(isReady), map((state) => state.value.name), take(1)));

type ScopeEntry = NonNullable<StreamConnect['scoped']>[number];

/** The entry for `scope` of the first connect that subscribes to it. */
const scopeEntry = (connects: readonly StreamConnect[], scope: string): ScopeEntry | undefined =>
  connects.flatMap((connect) => (connect.scoped === undefined ? [] : connect.scoped)).find((entry) => entry.scope === scope);

/** A storage that remembers every key it was asked for. */
class ReadStorage extends SharedStorage {
  readonly reads: string[] = [];

  override get(key: string): string | null {
    this.reads.push(key);
    return super.get(key);
  }
}

describe('protocol/specs/src/session/persisted-cases.json', () => {
  describe('keys', () => {
    it.each(table.keys)('$why', (row) => {
      expect(personKey(row.did)).toBe(row.personKey);
      expect(lastEventIdKey(row.kbId, row.personKey)).toBe(row.lastEventIdKey);
      expect([...PERSISTED_QUERIES]).toEqual(Object.keys(row.cacheKeys));
      for (const query of PERSISTED_QUERIES) {
        expect(cacheKey(row.kbId, row.personKey, query)).toBe(row.cacheKeys[query]);
      }
    });

    it.each(Object.entries(table.people))("%s's key is the one their did makes", (_, person) => {
      expect(personKey(person.did)).toBe(person.personKey);
    });

    it.each(table.keys)("a client kept for the person reads every persisted query's key and the stream's places as it is made, and no other kept key: $why", async (row) => {
      const storage = new ReadStorage();
      storeSignIn(storage, row.kbId, 'named', row.personKey, freshJwt());
      const gateway = fakeGateway({ whoIs: async () => Response.json({ ...table.whoAmI, did: row.did }), issuer: renews, resourceName: 'fresh' });

      const session = sessionOver(gateway, kbNamed(row.kbId), storage);
      const read = [...storage.reads];
      await session.ready;
      end(session, gateway);

      expect(read.filter((key) => key.startsWith(stored.cacheKeyPrefix.prefix))).toEqual(Object.values(row.cacheKeys));
      expect(read.filter((key) => key.startsWith(stored.lastEventIdKeyPrefix.prefix))).toEqual([row.lastEventIdKey]);
    });
  });

  describe('forget', () => {
    const CLOSING = 'written as the client closed';

    /** Sessions over a client of no gateway; kb-a's client writes under jo's `resource` key as it closes. */
    const closingWrites: SessionFactory = ({ kb, storage }) => {
      const { client } = createTestClient({ busTimeoutMs: 40 });
      if (kb.id === KB_A.id) {
        const close = client.dispose.bind(client);
        client.dispose = () => {
          close();
          storage.set(cacheKey(KB_A.id, jo.personKey, 'resource'), CLOSING);
        };
      }
      return new SemiontSession({ kb, storage, client, token$: new BehaviorSubject<AccessToken | null>(null) });
    };

    /** The registry forgets kb-a's sign-in as it is asked to, with the stand-in for an open client. */
    const forgetByRegistry = async (storage: SessionStorage, row: ForgetRow): Promise<void> => {
      const browser = new SemiontBrowser({
        storage,
        sessionFactory: closingWrites,
        fetch: async () => new Response(null, { status: 200 }),
      });
      await firstValueFrom(browser.activeSession$.pipe(filter((session) => session !== null)));
      expect(browser.activeKbId$.getValue()).toBe(row.open ? KB_A.id : KB_B.id);
      if (row.by === 'signOut') await browser.signOut(KB_A.id);
      else browser.removeKb(KB_A.id);
      await browser.dispose();
    };

    /**
     * kb-a's own session, as the registry makes it, ends: the gateway refuses
     * every token it is asked about, and the issuer refuses the renewal
     * (expiry) or makes it (refusal: the renewed token is refused too).
     */
    const forgetBySession = async (storage: SessionStorage, row: ForgetRow): Promise<void> => {
      const gateway = fakeGateway({
        whoIs: async () => new Response(null, { status: 401 }),
        issuer: row.by === 'refusal' ? renews : refuses,
        resourceName: 'fresh',
      });
      const browser = new SemiontBrowser({ storage, sessionFactory: createHttpSessionFactory(gateway.fetch), fetch: gateway.fetch });
      try {
        await vi.waitFor(() => expect(getStoredSession(storage, KB_A.id)).toBeNull());
      } finally {
        await browser.dispose();
        gateway.close();
      }
    };

    it.each(table.forget)('$by: $why', async (row) => {
      const storage = new SharedStorage();
      seed(storage, table.forgetStorage);
      storeSignIn(storage, KB_A.id, row.signedIn, jo.personKey, row.stored === 'expired' ? freshJwt(-60) : freshJwt());
      storage.set(STORAGE_KEY, JSON.stringify([KB_A, KB_B]));
      storage.set(ACTIVE_KEY, row.open ? KB_A.id : KB_B.id);

      if (row.by === 'signOut' || row.by === 'removal') await forgetByRegistry(storage, row);
      else await forgetBySession(storage, row);

      const removed = row.removes === 'person' ? keysOf(KB_A.id, jo.personKey) : [];
      for (const key of removed) expect(storage.get(key), key).toBeNull();
      for (const [key, value] of Object.entries(table.forgetStorage)) {
        if (!removed.includes(key)) expect(storage.get(key), key).toBe(value);
      }
      expect(getStoredSession(storage, KB_A.id)).toBeNull();
    });
  });

  describe('startup', () => {
    it.each(table.startup)('$why', async (row) => {
      const storage = new SharedStorage();
      seed(storage, table.startupStorage);
      storeSignIn(storage, KB_A.id, row.signedIn, jo.personKey, freshJwt());
      const { gateway, release } = heldGateway(row.gateway);
      const session = sessionOver(gateway, KB_A, storage);
      let first: string | undefined;
      const then: string[] = [];
      let place: string | undefined;
      try {
        first = await firstName(session, 'res-2');

        release();
        await session.ready;
        if (row.recorded === null) {
          expect(getStoredSession(storage, KB_A.id)?.personKey).toBeUndefined();
        } else {
          const recorded = row.recorded;
          await vi.waitFor(() => expect(getStoredSession(storage, KB_A.id)?.personKey).toBe(recorded));
        }

        const holding = session.client.browse.resource(resourceId('res-1')).subscribe((state) => {
          if (isReady(state)) then.push(state.value.name);
        });
        await vi.waitFor(() => {
          expect(then.length).toBeGreaterThan(0);
          expect(scopeEntry(gateway.connects, 'res-1')).toBeDefined();
        });
        place = scopeEntry(gateway.connects, 'res-1')?.lastEventId;
        holding.unsubscribe();
      } finally {
        end(session, gateway);
      }

      expect(first).toBe(row.first);
      expect(then[0]).toBe(row.then);
      expect(place === undefined ? null : place).toBe(row.place);
      if (row.untouched === true) {
        for (const [key, value] of Object.entries(table.startupStorage)) expect(storage.get(key), key).toBe(value);
        const keptKeys = storage.keys().filter((key) =>
          key.startsWith(stored.cacheKeyPrefix.prefix) || key.startsWith(stored.lastEventIdKeyPrefix.prefix));
        expect(keptKeys.sort()).toEqual(Object.keys(table.startupStorage).sort());
      }
    });
  });

  describe('crossTab', () => {
    /** What another context writes as kb-a's stored sign-in: nothing, or one with other tokens naming whom the row says. */
    const writeElsewhere = (elsewhere: SessionStorage, written: CrossTabRow['stored']): void => {
      if (written === null) {
        elsewhere.delete(sessionKey(KB_A.id));
        return;
      }
      const signIn = testSession(freshJwt(), 'refresh-elsewhere');
      elsewhere.set(
        sessionKey(KB_A.id),
        JSON.stringify(written.personKey === null ? signIn : { ...signIn, personKey: written.personKey }),
      );
    };

    /** Whether jo's `resource` key holds res-1 as the gateway answered it. */
    const savedRes1 = (storage: SessionStorage): boolean => {
      const raw = storage.get(cacheKey(KB_A.id, jo.personKey, 'resource'));
      if (raw === null) return false;
      const document = JSON.parse(raw) as { entries: Array<[unknown, { name: string }, number]> };
      return document.entries.some(([key, value]) => key === 'res-1' && value.name === 'fresh');
    };

    it.each(table.crossTab)('$why', async (row) => {
      const here = new SharedStorage();
      const elsewhere = here.context();
      storeSignIn(here, KB_A.id, 'named', jo.personKey, freshJwt());
      const { gateway, release } = heldGateway('names');
      release();
      const session = sessionOver(gateway, KB_A, here);
      try {
        await session.ready;
        // The gateway's answer, which reaches the cache now and is written
        // only once the save's wait is over: the write elsewhere comes first.
        expect(await firstName(session, 'res-1')).toBe('fresh');
        writeElsewhere(elsewhere, row.stored);
      } finally {
        end(session, gateway);
      }

      expect(savedRes1(here)).toBe(row.saved);
    });
  });
});
