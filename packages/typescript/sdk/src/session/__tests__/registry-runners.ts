/**
 * What the runners of the registry's tables share: the knowledge base a
 * registry signs in to, where the fake gateway is (fake-gateway.ts); Jo, whom
 * that gateway says every token is; a sign-in kept for Jo; and a session's
 * client left owing its save, still waiting out its debounce.
 */

import { vi } from 'vitest';
import { filter, firstValueFrom } from 'rxjs';
import { resourceId } from '@semiont/core';
import type { NewKnowledgeBase } from '@semiont/core';
import { isReady } from '../../cache';
import type { SemiontSession } from '../semiont-session';
import { personKey, type StoredSession } from '../storage';
import { fakeGateway, GATEWAY_ENDPOINT, renews, type FakeGateway } from './fake-gateway';
import { freshJwt, testSession } from './test-storage-helpers';

/** The knowledge base each registry signs in to, where the fake gateway is. */
export const KB: NewKnowledgeBase = { did: 'did:web:kb.example.org:kb-a', label: 'KB A', endpoint: GATEWAY_ENDPOINT };

/** Whom the gateway says every token is. */
export const JO = { did: 'did:web:example.org:users:jo', email: 'jo@example.org', name: 'Jo', image: null, domain: 'example.org' };

/** A sign-in kept for Jo, naming them: the client of a session over it keeps for Jo from its start. */
export function keptForJo(): StoredSession {
  return { ...testSession(freshJwt(), 'refresh'), personKey: personKey(JO.did) };
}

/** A gateway that says every token is Jo's, whose issuer renews every token, and that names every resource read `kept`. */
export function joGateway(): FakeGateway {
  return fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'kept' });
}

/**
 * Leave `session`'s client owing its save: a read of a resource, made while
 * the clock is held. The save the read leaves owing waits out its debounce on
 * a timer that never falls due, so the client's close is the first to make it.
 */
export async function owingItsSave(session: SemiontSession): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await firstValueFrom(session.client.browse.resource(resourceId('res-1')).pipe(filter(isReady)));
  } finally {
    vi.useRealTimers();
  }
}
