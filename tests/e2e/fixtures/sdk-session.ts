/**
 * The e2e suite's signed-in SDK session — ONE construction, shared.
 *
 * Every spec that drives the gateway directly (rather than through the
 * browser) needs the same thing: credentials in, a wired client out. That was
 * fourteen copies of `SemiontClient.signInHttp({ baseUrl, email, password })`
 * before SSE-AUTH-RESILIENCE P5 deleted that factory as the non-refreshing
 * trap it was; collapsing them here is the other half of that change.
 *
 * This is the suite's constants bound to `lib/session.ts`'s config-free
 * builder — the split exists so `scripts/seed.ts`, which takes its connection
 * as arguments, needs no dependency on `playwright.config`.
 */

import { sessionFor } from '../lib/session';
import { GATEWAY_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import type { SemiontSession } from '@semiont/sdk';

/**
 * Sign in over HTTP and return a live session. Callers reach the verbs through
 * `session.client` and MUST `await session.dispose()` when done — a session
 * owns a refresh timer, so leaking one keeps a worker alive.
 */
export async function signInSession(id = 'e2e'): Promise<SemiontSession> {
  return sessionFor({ baseUrl: GATEWAY_URL, email: E2E_EMAIL, password: E2E_PASSWORD, id });
}
