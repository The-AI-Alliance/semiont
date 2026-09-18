/**
 * What a completed sign-in learns about the knowledge base it reached: the
 * identity the KB reports of itself, and who the issuer says the user is —
 * both read from the KB with the fresh token, never assumed from the address
 * the user typed or the row they clicked.
 */

import { BehaviorSubject } from 'rxjs';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import { accessToken, baseUrl, type AccessToken } from '@semiont/core';
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
  /** The KB's own name; '' when it reports none — the word for that absence is a render concern. */
  label: string;
  email: string;
  gitBranch?: string;
}

export async function describeConnection(target: HttpEndpoint, access: string): Promise<ConnectionIdentity> {
  // `/api/status` requires authentication, so the throwaway client carries
  // the token from birth — the same pattern the session factory's validate
  // uses. Everything it opens is torn down on every exit.
  const token$ = new BehaviorSubject<AccessToken | null>(accessToken(access));
  const transport = new HttpTransport({ baseUrl: baseUrl(kbGatewayUrl(target)), token$ });
  const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
  try {
    let status;
    try {
      status = await client.admin!.status();
    } catch (e) {
      throw new IdentityUnverifiableError('unreachable', e instanceof Error ? e.message : String(e));
    }
    if (!status.did) throw new IdentityUnverifiableError('not-reported', 'status reported no did');
    const me = await client.auth!.me();
    return {
      did: status.did,
      label: status.projectName ?? '',
      email: me.email,
      ...(status.gitBranch ? { gitBranch: status.gitBranch } : {}),
    };
  } finally {
    client.dispose();
    token$.complete();
  }
}
