/**
 * Build a signed-in SDK session from explicit connection details, through
 * the issuer the knowledge base trusts.
 *
 * Config-free on purpose: `scripts/seed.ts` takes its gateway and credentials
 * as arguments and must not acquire a dependency on `playwright.config`. The
 * spec-facing wrapper that supplies the suite's constants is
 * `fixtures/sdk-session.ts`.
 *
 * Headless, but honest: there is no password grant to call. The sign-in is
 * the same authorization-code grant with PKCE the Browser runs — begun by
 * the SDK, approved on the issuer's own login page by a throwaway Playwright
 * page, completed by the SDK from the redirect that page intercepts. Nothing
 * here needs the Browser app to be running, and no test-only client exists
 * at the issuer.
 *
 * A session rather than a bare client (SSE-AUTH-RESILIENCE P5): the access
 * token lives minutes, and a seed run or a long spec outlives that; the
 * session renews it at the issuer. `InMemorySessionStorage` because these
 * processes want no persistence: each run signs in fresh and takes nothing
 * with it.
 */

import { chromium } from '@playwright/test';
import {
  BROWSER_CLIENT_ID,
  InMemorySessionStorage,
  SemiontSession,
  beginAuthorization,
  completeAuthorization,
  httpKb,
} from '@semiont/sdk';

/** Registered for every Browser origin at the issuer; nothing needs to answer here. */
const CALLBACK = 'http://localhost:3000/en/auth/callback';

export async function sessionFor(opts: {
  baseUrl: string;
  email: string;
  password: string;
  /** KB id — only distinguishes storage keys, and storage is in-memory here. */
  id?: string;
}): Promise<SemiontSession> {
  const url = new URL(opts.baseUrl);
  const endpoint = {
    kind: 'http' as const,
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    protocol: url.protocol === 'https:' ? ('https' as const) : ('http' as const),
  };
  const storage = new InMemorySessionStorage();
  const authorizationUrl = await beginAuthorization({ target: endpoint, redirectUri: CALLBACK }, storage);

  const browser = await chromium.launch();
  let callbackUrl: string;
  try {
    const page = await browser.newPage();
    await page.route(`${CALLBACK}*`, (route) => route.fulfill({ status: 200, body: 'signed in' }));
    const returned = page.waitForRequest((request) => request.url().startsWith(CALLBACK));
    await page.goto(authorizationUrl);
    // The issuer's login page. These are the ids of the launcher-run
    // Keycloak's default theme — the e2e stack's issuer, not a Semiont surface.
    await page.fill('#username', opts.email);
    await page.fill('#password', opts.password);
    await page.click('#kc-login');
    callbackUrl = (await returned).url();
  } finally {
    await browser.close();
  }

  const { pending, tokens } = await completeAuthorization(callbackUrl, storage);
  return SemiontSession.fromIssuedSession({
    kb: httpKb({
      id: opts.id ?? 'e2e',
      label: 'E2E',
      host: endpoint.host,
      port: endpoint.port,
      protocol: endpoint.protocol,
    }),
    storage,
    baseUrl: opts.baseUrl,
    session: {
      access: tokens.access,
      refresh: tokens.refresh,
      clientId: BROWSER_CLIENT_ID,
      tokenEndpoint: pending.issuer.token,
      ...(pending.issuer.revocation ? { revocationEndpoint: pending.issuer.revocation } : {}),
    },
  });
}
