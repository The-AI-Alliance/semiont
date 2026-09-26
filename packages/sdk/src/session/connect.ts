/**
 * What a completed sign-in learns about the knowledge base it reached: what
 * the KB says of itself, read from the KB with the fresh token, never assumed
 * from the address the user typed or the row they clicked.
 */

import { BehaviorSubject } from 'rxjs';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import { accessToken, baseUrl, BusRequestError, kbDid, replyChannelsFor, type AccessToken, type KbDescription } from '@semiont/core';
import { SemiontClient } from '../client';
import type { HttpEndpoint } from './knowledge-base';
import { kbGatewayUrl } from './storage';

/**
 * Thrown when the sign-in succeeded but the KB's identity cannot be
 * established. A registered KB REQUIRES a did (KB-IDENTITY-VS-ADDRESS
 * decision 8), and there is nothing legitimate to fall back to: inventing
 * one from the address is the category error that document exists to end.
 * The two reasons stay apart deliberately — one message for both once hid a
 * live auth bug from the UI.
 */
export class IdentityUnverifiableError extends Error {
  constructor(readonly reason: 'unreachable' | 'not-reported', detail: string) {
    super(detail);
    this.name = 'IdentityUnverifiableError';
  }
}

export interface ConnectionIdentity {
  did: string;
  description: KbDescription;
}

export async function describeConnection(target: HttpEndpoint, access: string): Promise<ConnectionIdentity> {
  // The KB describes itself only to a signed-in caller, so the throwaway
  // client carries the token from birth. It subscribes to this one
  // operation's replies and nothing else. Everything it opens is torn down on
  // every exit.
  const token$ = new BehaviorSubject<AccessToken | null>(accessToken(access));
  const transport = new HttpTransport({
    baseUrl: baseUrl(kbGatewayUrl(target)),
    token$,
    channels: replyChannelsFor(['browse:kb-requested']),
  });
  const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
  try {
    let description: KbDescription;
    try {
      description = await client.browse.kb();
    } catch (e) {
      // A refusal is the KB answering that it cannot say what it is; any
      // other failure is not having reached it.
      const reason = e instanceof BusRequestError && e.code === 'bus.rejected' ? 'not-reported' : 'unreachable';
      throw new IdentityUnverifiableError(reason, e instanceof Error ? e.message : String(e));
    }
    return { did: kbDid(description.domain), description };
  } finally {
    client.dispose();
    token$.complete();
  }
}
