import { test as base, expect, type Page } from '@playwright/test';
import { GATEWAY_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import { attachBusLog, type BusLogCapture } from './bus-log';
import { JaegerCapture, attachJaegerEvidence } from './jaeger';
import { attachPageErrors, attachPageErrorsArtifact, type PageErrorsCapture } from './page-errors';

/**
 * Sign in via the real UI: Connect → host/port → the issuer's login page →
 * back to the Browser's callback, which registers the knowledge base.
 *
 * Leaves the page on `/en/know/discover` with a live authenticated session.
 * Idempotent: re-invocation on an already-signed-in page is a no-op.
 */
export async function signIn(page: Page): Promise<void> {
  // Start at the root; the locale redirect drops us on /en and eventually
  // /en/know/discover after session resolution.
  await page.goto('/');

  // If the session is already authenticated (persisted context), the app
  // is already on a know/* route. Detect that and bail.
  if (await isAlreadySignedIn(page)) return;

  const gateway = new URL(GATEWAY_URL);
  const host = gateway.hostname;
  const port = gateway.port || (gateway.protocol === 'https:' ? '443' : '80');
  const protocol = gateway.protocol === 'https:' ? 'https' : 'http';

  // KnowledgeBasePanel auto-opens the Connect form when there are zero
  // registered KBs. When at least one KB is registered, the form is
  // collapsed and we have to click "Add Knowledge Base" first. Race the
  // two states rather than assuming one.
  const hostField = page.getByRole('textbox', { name: /^host$/i });
  const addButton = page.getByRole('button', { name: /add knowledge base/i });

  await expect(async () => {
    const hostVisible = await hostField.isVisible().catch(() => false);
    const addVisible = await addButton.isVisible().catch(() => false);
    expect(hostVisible || addVisible).toBe(true);
  }).toPass({ timeout: 15_000 });

  if (!(await hostField.isVisible().catch(() => false))) {
    await addButton.click();
    await expect(hostField).toBeVisible({ timeout: 5_000 });
  }

  // Fill the form. Fields have labels derived from their placeholder
  // text (the ConnectForm uses `placeholder="Host"` etc which Playwright's
  // accessibility tree exposes as textbox names).
  //
  // IMPORTANT: set host BEFORE protocol. Filling the host runs
  // `handleHostChange` which calls `defaultProtocol(host)` and can flip
  // the protocol to HTTPS for IP-like hostnames, overwriting an earlier
  // protocol selection.
  await hostField.fill(host);
  await page.getByRole('combobox').first().selectOption(protocol);
  await page.getByRole('spinbutton').first().fill(port);

  // Connect leaves for the issuer the KB trusts. The credentials are
  // entered THERE — on the launcher-run Keycloak's login page, whose default
  // theme names its fields by these ids — never in the Browser.
  await page.getByRole('button', { name: /^connect$/i }).click();
  await page.waitForURL(/\/realms\//, { timeout: 20_000 });
  await page.locator('#username').fill(E2E_EMAIL);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('#kc-login').click();

  // The issuer sends the page back to /auth/callback, which registers the
  // KB and lands on the knowledge section.
  await expect(async () => {
    const signedIn = await isAlreadySignedIn(page);
    expect(signedIn).toBe(true);
  }).toPass({ timeout: 30_000 });
}

/**
 * Best-effort heuristic: we're signed in if the discover route is visible
 * and the connect form is not.
 */
async function isAlreadySignedIn(page: Page): Promise<boolean> {
  // A visible connect form implies either signed out or still loading.
  const hostInput = page.getByRole('textbox', { name: /^host$/i });
  const hostVisible = await hostInput.isVisible().catch(() => false);
  if (hostVisible) return false;

  // The authenticated Knowledge section uses a /know/ URL and has no
  // connect form; that combination is proof-of-auth.
  const url = page.url();
  return /\/know\//.test(url);
}

/**
 * Playwright test with a signed-in fixture. Use like:
 *
 *   import { test } from '../fixtures/auth';
 *
 *   test('something', async ({ signedInPage }) => {
 *     // already at /en/know/discover with a valid session
 *   });
 */
export const test = base.extend<{
  signedInPage: Page;
  bus: BusLogCapture;
  jaeger: JaegerCapture;
  pageErrors: PageErrorsCapture;
}>({
  bus: async ({ page }, use) => {
    const capture = await attachBusLog(page);
    await use(capture);
  },
  pageErrors: async ({ page }, use, testInfo) => {
    // Captures uncaught browser errors during the test. Soft by default
    // (attaches a `page-errors.json` artifact when entries exist);
    // set `PAGE_ERRORS_FAIL=1` to fail tests with errors. See
    // `fixtures/page-errors.ts` for the wiring rationale.
    const capture = await attachPageErrors(page);
    await use(capture);
    await attachPageErrorsArtifact(testInfo, capture);
  },
  jaeger: async ({ bus }, use, testInfo) => {
    // Records the start time so the teardown query has a tight window.
    // Depends on `bus` so prefix capture is wired before any test code
    // runs. After `use`, fetches matching Jaeger traces and attaches
    // them to the Playwright report (failure-only by default; configurable
    // via `JAEGER_ATTACH=always|failure|off`).
    const capture = new JaegerCapture();
    await use(capture);
    await attachJaegerEvidence(testInfo, bus, capture);
  },
  signedInPage: async ({ page, bus: _bus, jaeger: _jaeger, pageErrors: _pageErrors }, use) => {
    // Depend on `bus` and `jaeger` so the init scripts run before signIn
    // and the Jaeger teardown sees the full test window. The unused
    // parameters force fixture ordering.
    await signIn(page);
    await use(page);
  },
});

export { expect };
export type { BusLogCapture } from './bus-log';
export type { JaegerCapture } from './jaeger';
export type { PageErrorsCapture } from './page-errors';
