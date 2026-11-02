/**
 * The e2e suite's signed-in SDK session — ONE construction, shared.
 *
 * Every spec that drives the gateway directly (rather than through the
 * browser) needs the same thing: a signed-in, refreshing session.
 *
 * This is the suite's constants bound to `lib/session.ts`'s config-free
 * builder — the split exists so `scripts/seed.ts`, which takes its connection
 * as arguments, needs no dependency on `playwright.config`.
 */

import { sessionFor } from '../lib/session';
import { GATEWAY_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import type { OpenedSession } from '@semiont/sdk';

/**
 * Sign in over HTTP and return a live session with its client. Callers reach
 * the verbs through `opened.session.client` and MUST call `opened.dispose()`
 * when done: it ends the session, whose refresh timer would keep a worker
 * alive, and closes the client's stream.
 */
export async function signInSession(id = 'e2e'): Promise<OpenedSession> {
  return sessionFor({ baseUrl: GATEWAY_URL, email: E2E_EMAIL, password: E2E_PASSWORD, id });
}
