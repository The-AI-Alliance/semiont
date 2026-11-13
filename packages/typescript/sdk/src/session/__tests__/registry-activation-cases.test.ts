/**
 * How a registry activates a knowledge base, run by every SDK: when its
 * factory refuses the session, once its close has begun, and when another
 * knowledge base's session is active
 * (protocol/specs/src/session/registry-activation-cases.json); and what it
 * says when its factory fails with something that is not one of the
 * session's own errors (protocol/specs/src/session/registry-factory-failure-cases.json).
 *
 * Every row runs a registry over a storage in which each of its knowledge
 * bases is registered with a sign-in kept for Jo, so the registry activates
 * the one stored as active as it is made. Its factory records each knowledge
 * base it is asked for a session of, in order, and then refuses as the row
 * says or builds the session the HTTP session factory builds, over a gateway
 * that is `fetch` and nothing else (fake-gateway.ts), as a registry's
 * sessions are.
 *
 * Where a row's first session owes a save, a read of a resource made while
 * the clock is held leaves its client owing it, still waiting out its
 * debounce, and the storage records its write in the list the factory
 * records its asks in: `switching` holds the order of the two to the rule,
 * and `closing` begins its activation from within that write, which a
 * TypeScript storage makes synchronously.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { filter, firstValueFrom } from 'rxjs';
import { BusRequestError, PERSISTED_QUERIES, SemiontError } from '@semiont/core';
import type { KnowledgeBase, SemiontSessionErrorCode, TransportErrorCode } from '@semiont/core';
import { SemiontSessionError } from '../errors';
import { createHttpSessionFactory } from '../http-session-factory';
import { SemiontBrowser } from '../semiont-browser';
import type { SemiontSession } from '../semiont-session';
import type { SessionFactory } from '../session-factory';
import type { SessionStorage } from '../session-storage';
import { ACTIVE_KEY, cacheKey, lastEventIdKey, personKey, saveKnowledgeBases, setStoredSession } from '../storage';
import { GATEWAY_ENDPOINT } from './fake-gateway';
import { JO, KB, joGateway, keptForJo, owingItsSave } from './registry-runners';
import { RefusingStorage, TestStorage } from './test-storage-helpers';

/** One of the session's own errors, by its code, with its message. */
interface Own {
  own: SemiontSessionErrorCode;
  message: string;
}

/** What a registry says on its errors, by its code and its message. */
interface Said {
  code: SemiontSessionErrorCode;
  message: string;
}

interface RefusedRow {
  why: string;
  refusal: Own;
  registryErrors: Said[];
}

interface ClosedRow {
  why: string;
  while: 'closed' | 'closing';
}

interface SwitchingRow {
  why: string;
  storage: 'writes' | 'refuses';
  next: 'built' | Own;
  registryErrors: SemiontSessionErrorCode[];
  active: boolean;
}

interface FailureRow {
  why: string;
  failure: { transport: TransportErrorCode; message: string };
  registryErrors: Said[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTIVATION = join(HERE, '../../../../../../protocol/specs/src/session/registry-activation-cases.json');
const FACTORY_FAILURE = join(HERE, '../../../../../../protocol/specs/src/session/registry-factory-failure-cases.json');
const { refused, closed, switching } = JSON.parse(readFileSync(ACTIVATION, 'utf-8')) as {
  refused: RefusedRow[];
  closed: ClosedRow[];
  switching: SwitchingRow[];
};
const { cases: failures } = JSON.parse(readFileSync(FACTORY_FAILURE, 'utf-8')) as { cases: FailureRow[] };

/** The knowledge base whose session is active first. */
const KB_A: KnowledgeBase = { id: 'kb-a', ...KB };
/** The knowledge base activated next, at the same gateway. */
const KB_B: KnowledgeBase = { id: 'kb-b', did: 'did:web:kb.example.org:kb-b', label: 'KB B', endpoint: GATEWAY_ENDPOINT };

const JO_KEY = personKey(JO.did);
/** Where the save the first session's client owes is written: what it keeps of the resource it read. */
const OWED_SAVE = cacheKey(KB_A.id, JO_KEY, 'resource');
/** Every key the first session's client writes under: its kept queries' documents and its stream's places. */
const FIRST_CLIENTS_KEYS = new Set([...PERSISTED_QUERIES.map((query) => cacheKey(KB_A.id, JO_KEY, query)), lastEventIdKey(KB_A.id, JO_KEY)]);

const askedFor = (kb: KnowledgeBase): string => `asked for ${kb.id}`;
const WROTE_THE_OWED_SAVE = 'wrote the owed save';

/** Register each of `kbs` in `storage`, with a sign-in kept for Jo, and `active` as the knowledge base active. */
function register(storage: SessionStorage, kbs: KnowledgeBase[], active: KnowledgeBase): void {
  saveKnowledgeBases(storage, kbs);
  for (const kb of kbs) setStoredSession(storage, kb.id, keptForJo());
  storage.set(ACTIVE_KEY, active.id);
}

/** A factory that records in `steps` each knowledge base it is asked for a session of, and then answers as `answer` does. */
function recording(steps: string[], answer: SessionFactory): SessionFactory {
  return (opts) => {
    steps.push(askedFor(opts.kb));
    return answer(opts);
  };
}

/** What `browser` says on its errors: what it kept for its first reader, and everything after. */
function readErrors(browser: SemiontBrowser): SemiontSessionError[] {
  const read: SemiontSessionError[] = [];
  browser.error$.subscribe((error) => read.push(error));
  return read;
}

const live = (browser: SemiontBrowser): Promise<SemiontSession> =>
  firstValueFrom(browser.activeSession$.pipe(filter((session): session is SemiontSession => session !== null)));

/** Activate `KB_B`: what the activation ended with, the value it was refused with or `activated`. */
const activateB = (browser: SemiontBrowser): Promise<unknown> =>
  browser.setActiveKb(KB_B.id).then(() => 'activated', (refusal: unknown) => refusal);

/**
 * No session being active, a registry activates a registered knowledge base
 * with a kept sign-in, over a factory that refuses with `refusal`. Gives what
 * the registry said on its errors once the activation has returned, each by
 * its code and its message. Then no session is active, its factory was asked
 * for one session, and the storage's active key names that knowledge base.
 */
async function refusedWith(refusal: Error): Promise<Said[]> {
  const steps: string[] = [];
  const storage = new TestStorage();
  register(storage, [KB_A], KB_A);
  const browser = new SemiontBrowser({ storage, sessionFactory: recording(steps, () => { throw refusal; }) });
  const read = readErrors(browser);
  try {
    await firstValueFrom(browser.sessionActivating$.pipe(filter((activating) => !activating)));
    expect(steps).toEqual([askedFor(KB_A)]);
    expect(browser.activeSession$.getValue()).toBeNull();
    expect(storage.get(ACTIVE_KEY)).toBe(KB_A.id);
    return read.map(({ code, message }) => ({ code, message }));
  } finally {
    await browser.dispose();
  }
}

/** The refusal of a switching row's next session; null when it is built. */
function refusalOfNext(next: SwitchingRow['next']): Own | null {
  if (next === 'built') return null;
  if (typeof next === 'object' && typeof next.own === 'string') return next;
  throw new Error(`No runner for a next session that is ${JSON.stringify(next)}`);
}

describe('protocol/specs/src/session/registry-activation-cases.json', () => {
  describe('refused', () => {
    it.each(refused)('$refusal.own: $why', async (row) => {
      const said = await refusedWith(new SemiontSessionError(row.refusal.own, row.refusal.message, KB_A.id));
      expect(said).toEqual(row.registryErrors);
    });
  });

  describe('closed', () => {
    it.each(closed)('$while: $why', async (row) => {
      if (row.while !== 'closed' && row.while !== 'closing') throw new Error(`No runner for a close that is ${JSON.stringify(row.while)}`);
      const steps: string[] = [];
      const refusals: Promise<unknown>[] = [];
      let registry: SemiontBrowser | undefined;
      // The owed save is written, and nothing refused; while the registry is closing, its activation is begun from within the write.
      const storage = new RefusingStorage((key) => {
        if (key !== OWED_SAVE) return false;
        steps.push(WROTE_THE_OWED_SAVE);
        if (row.while === 'closing') {
          if (registry === undefined) throw new Error('The owed save was written before the registry was made');
          refusals.push(activateB(registry));
        }
        return false;
      });
      register(storage, [KB_A, KB_B], KB_A);
      const gateway = joGateway();
      const browser = new SemiontBrowser({ storage, sessionFactory: recording(steps, createHttpSessionFactory(gateway.fetch)) });
      registry = browser;
      const read = readErrors(browser);
      try {
        const first = await live(browser);
        if (row.while === 'closing') await owingItsSave(first);
        await browser.dispose();
        if (row.while === 'closed') refusals.push(activateB(browser));

        expect(refusals).toHaveLength(1);
        const refusal = await refusals[0];
        expect(refusal).toBeInstanceOf(BusRequestError);
        expect(refusal).toMatchObject({ code: 'bus.closed' });
        const asked = row.while === 'closing' ? [askedFor(KB_A), WROTE_THE_OWED_SAVE] : [askedFor(KB_A)];
        expect(steps).toEqual(asked);
        expect(read).toEqual([]);
        expect(storage.get(ACTIVE_KEY)).toBe(KB_A.id);

        // A second close does nothing.
        await browser.dispose();
        expect(steps).toEqual(asked);
      } finally {
        gateway.close();
      }
    });
  });

  describe('switching', () => {
    it.each(switching)('storage $storage: $why', async (row) => {
      if (row.storage !== 'writes' && row.storage !== 'refuses') throw new Error(`No runner for a storage that ${JSON.stringify(row.storage)}`);
      const next = refusalOfNext(row.next);
      const steps: string[] = [];
      const storage = new RefusingStorage((key) => {
        if (key === OWED_SAVE) steps.push(WROTE_THE_OWED_SAVE);
        return row.storage === 'refuses' && FIRST_CLIENTS_KEYS.has(key);
      });
      register(storage, [KB_A, KB_B], KB_A);
      const gateway = joGateway();
      const built = createHttpSessionFactory(gateway.fetch);
      const browser = new SemiontBrowser({
        storage,
        sessionFactory: recording(steps, (opts) => {
          if (next !== null && opts.kb.id === KB_B.id) throw new SemiontSessionError(next.own, next.message, KB_B.id);
          return built(opts);
        }),
      });
      const read = readErrors(browser);
      try {
        await owingItsSave(await live(browser));
        await browser.setActiveKb(KB_B.id);

        // The first session ended, its owed save written once, by its closing flush, before the next was asked for.
        expect(steps).toEqual([askedFor(KB_A), WROTE_THE_OWED_SAVE, askedFor(KB_B)]);
        expect(read.map((error) => error.code)).toEqual(row.registryErrors);
        expect(browser.activeSession$.getValue() !== null).toBe(row.active);
      } finally {
        await browser.dispose();
        gateway.close();
      }
    });
  });
});

describe('protocol/specs/src/session/registry-factory-failure-cases.json', () => {
  it.each(failures)('$failure.transport: $why', async (row) => {
    const said = await refusedWith(new SemiontError(row.failure.message, row.failure.transport));
    expect(said).toEqual(row.registryErrors);
  });
});
