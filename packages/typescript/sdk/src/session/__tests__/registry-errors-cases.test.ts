/**
 * How a registry reads the errors of each session it activates: one table,
 * protocol/specs/src/session/registry-errors-cases.json, run by every SDK.
 *
 * `cases` runs a registry over a factory that builds a scripted session and
 * reads none of its errors: a real session and client over a transport whose
 * failures are exactly the code and message a case says, and a renewal that
 * records the token it is handed. The session says its own errors as a
 * factory's keeping says them (`sayOn`). What a case says `opening`, the
 * factory says as it builds the session; what it says `active`, it says once
 * the registry has activated it. Each case is held once the effect of what
 * the session said last is seen: its own error said on the registry's errors,
 * a renewal handed a token, or a refusal for lack of permission said through
 * the session's signals.
 *
 * `closing` runs a registry over the HTTP session factory, over a gateway
 * that is `fetch` and nothing else (fake-gateway.ts), as a registry's
 * sessions are: the session's client keeps for jo in the registry's storage,
 * which refuses every write once the session is active, and a read of a
 * resource leaves the client owing its save.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BehaviorSubject, Subject, filter, firstValueFrom, lastValueFrom, map, toArray, type Observable } from 'rxjs';
import { SemiontError, resourceId } from '@semiont/core';
import type { AccessToken, NewKnowledgeBase, SemiontSessionErrorCode, TransportErrorCode } from '@semiont/core';
import { isReady } from '../../cache';
import { SemiontClient } from '../../client';
import { FaultyTransport, inMemoryContent } from '../../testing';
import { SemiontSessionError } from '../errors';
import { createHttpSessionFactory } from '../http-session-factory';
import { SemiontBrowser } from '../semiont-browser';
import { SemiontSession, sayOn } from '../semiont-session';
import type { SessionFactory } from '../session-factory';
import { keptIn, personKey } from '../storage';
import { fakeGateway, GATEWAY_ENDPOINT, renews } from './fake-gateway';
import { RefusingStorage, TestStorage, freshJwt, testSession } from './test-storage-helpers';

/** What a case's session says: one of its own errors, by its code, or a failure of its transport, by its code, with its message. */
type Said = { own: SemiontSessionErrorCode } | { transport: TransportErrorCode; message: string };

interface Case {
  why: string;
  while: 'opening' | 'active';
  said: Said[];
  registryErrors: SemiontSessionErrorCode[];
  renewedWith?: 'held';
  permissionDenied?: string;
}

interface ClosingCase {
  why: string;
  owed: boolean;
  registryErrors: SemiontSessionErrorCode[];
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../protocol/specs/src/session/registry-errors-cases.json');
const { cases, closing } = JSON.parse(readFileSync(TABLE, 'utf-8')) as { cases: Case[]; closing: ClosingCase[] };

/** The knowledge base each registry signs in to, where the fake gateway is. */
const KB: NewKnowledgeBase = { did: 'did:web:kb.example.org:kb-a', label: 'KB A', endpoint: GATEWAY_ENDPOINT };

const JO = { did: 'did:web:example.org:users:jo', email: 'jo@example.org', name: 'Jo', image: null, domain: 'example.org' };

/** A scripted transport: a `FaultyTransport` whose failures are what `fail` is given, and nothing else. */
class FailingTransport extends FaultyTransport {
  readonly #failures = new Subject<SemiontError>();
  override readonly errors$: Observable<SemiontError> = this.#failures.asObservable();

  /** Say `failure` on the transport's errors, as a transport says a request's failure. */
  fail(failure: SemiontError): void {
    this.#failures.next(failure);
  }

  override dispose(): void {
    super.dispose();
    this.#failures.complete();
  }
}

/** What a scripted session said, each error as it said it, and the token it held as it began. */
interface Saying {
  readonly said: readonly SemiontError[];
  readonly held: AccessToken | null;
}

/** Say each of `entries` on `session`'s errors, in order: its own through `sayOn`, its transport's failures through `transport`. */
function sayAll(session: SemiontSession, transport: FailingTransport, entries: readonly Said[]): Saying {
  const held = session.token$.getValue();
  const said = entries.map((entry): SemiontError => {
    if ('own' in entry) {
      const own = new SemiontSessionError(entry.own, `the session says ${entry.own}`, session.kb.id);
      sayOn(session, own);
      return own;
    }
    const failure = new SemiontError(entry.message, entry.transport);
    transport.fail(failure);
    return failure;
  });
  return { said, held };
}

/**
 * A factory that builds a scripted session and reads none of its errors: a
 * real session and client over a `FailingTransport`, whose renewal records
 * each token it is handed and gives a new one. What `row` says `opening`, the
 * factory says as it builds the session, before handing it back.
 */
function scripted(row: Case): {
  factory: SessionFactory;
  transports: Map<SemiontSession, FailingTransport>;
  sayings: Map<SemiontSession, Saying>;
  handed: (string | null)[];
} {
  const transports = new Map<SemiontSession, FailingTransport>();
  const sayings = new Map<SemiontSession, Saying>();
  const handed: (string | null)[] = [];
  const factory: SessionFactory = ({ kb, storage }) => {
    const transport = new FailingTransport();
    const session = new SemiontSession({
      kb,
      kept: keptIn(storage, kb.id),
      client: new SemiontClient(transport, inMemoryContent()),
      token$: new BehaviorSubject<AccessToken | null>(null),
      refresh: async (holding) => {
        handed.push(holding);
        return freshJwt();
      },
    });
    transports.set(session, transport);
    if (row.while === 'opening') sayings.set(session, sayAll(session, transport, row.said));
    return session;
  };
  return { factory, transports, sayings, handed };
}

describe('protocol/specs/src/session/registry-errors-cases.json', () => {
  describe('cases', () => {
    it.each(cases)('$while: $why', async (row) => {
      const { factory, transports, sayings, handed } = scripted(row);
      const browser = new SemiontBrowser({ storage: new TestStorage(), sessionFactory: factory });
      // Read before the knowledge base is added: a session it activates says what it says opening as it is made.
      const read: SemiontSessionError[] = [];
      browser.error$.subscribe((error) => read.push(error));
      try {
        browser.addKb(KB, testSession(freshJwt(), 'refresh'));
        const active = await firstValueFrom(browser.activeSession$.pipe(filter((live): live is SemiontSession => live !== null)));
        const transport = transports.get(active);
        if (transport === undefined) throw new Error('the registry activated a session its factory did not make');
        const signals = browser.activeSignals$.getValue();
        if (signals === null) throw new Error('the registry activated a session without its signals');
        if (row.while === 'active') sayings.set(active, sayAll(active, transport, row.said));
        const saying = sayings.get(active);
        if (saying === undefined) throw new Error('the session said nothing');
        const last = saying.said[saying.said.length - 1];
        if (last === undefined) throw new Error('the case says nothing');

        // The effect of what the session said last.
        if (last instanceof SemiontSessionError) await vi.waitFor(() => expect(read).toContain(last));
        else if (last.code === 'unauthorized') await vi.waitFor(() => expect(handed.length).toBeGreaterThan(0));
        else if (last.code === 'forbidden') await vi.waitFor(() => expect(signals.permissionDenied$.getValue()).toEqual({ detail: last.message }));
        else throw new Error(`the case's last said, ${last.code}, has no effect to wait for`);

        expect(read.map((error) => error.code)).toEqual(row.registryErrors);
        if (row.renewedWith === 'held') {
          await vi.waitFor(() => expect(handed.length).toBeGreaterThan(0));
          expect(handed[0]).toBe(saying.held);
        } else {
          expect(handed).toEqual([]);
        }
        if (row.permissionDenied === undefined) expect(signals.permissionDenied$.getValue()).toBeNull();
        else expect(signals.permissionDenied$.getValue()).toEqual({ detail: row.permissionDenied });
      } finally {
        await browser.dispose();
      }
    });
  });

  describe('closing', () => {
    it.each(closing)('owed $owed: $why', async (row) => {
      const storage = new RefusingStorage();
      const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'kept' });
      const browser = new SemiontBrowser({ storage, sessionFactory: createHttpSessionFactory(gateway.fetch) });
      try {
        browser.addKb(KB, { ...testSession(freshJwt(), 'refresh'), personKey: personKey(JO.did) });
        const active = await firstValueFrom(browser.activeSession$.pipe(filter((live): live is SemiontSession => live !== null)));
        storage.refusing = true;
        // A value the client holds, whose save it owes until its closing: a save its debounce makes first is refused, and owed still.
        if (row.owed) await firstValueFrom(active.client.browse.resource(resourceId('res-1')).pipe(filter(isReady)));
        const said = lastValueFrom(browser.error$.pipe(map((error) => error.code), toArray()));
        await browser.dispose();
        expect(await said).toEqual(row.registryErrors);
      } finally {
        gateway.close();
      }
    });
  });
});
