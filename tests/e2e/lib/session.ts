/**
 * Build a signed-in SDK session from explicit connection details.
 *
 * Config-free on purpose: `scripts/seed.ts` takes its gateway and credentials
 * as arguments and must not acquire a dependency on `playwright.config`. The
 * spec-facing wrapper that supplies the suite's constants is
 * `fixtures/sdk-session.ts`.
 *
 * A session rather than a bare client (SSE-AUTH-RESILIENCE P5): the access
 * token lives TEN minutes, and a seed run or a long spec outlives that. The
 * non-refreshing `SemiontClient.signInHttp` this replaced would spend the back
 * half of such a run holding a dead token — the incident, reproduced in our own
 * tooling. `InMemorySessionStorage` because these processes want no
 * persistence: each run authenticates fresh and takes nothing with it.
 */

import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

export async function sessionFor(opts: {
  baseUrl: string;
  email: string;
  password: string;
  /** KB id — only distinguishes storage keys, and storage is in-memory here. */
  id?: string;
}): Promise<SemiontSession> {
  const url = new URL(opts.baseUrl);
  return SemiontSession.signInHttp({
    kb: httpKb({
      id: opts.id ?? 'e2e',
      label: 'E2E',
      email: opts.email,
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    }),
    storage: new InMemorySessionStorage(),
    baseUrl: opts.baseUrl,
    email: opts.email,
    password: opts.password,
  });
}
