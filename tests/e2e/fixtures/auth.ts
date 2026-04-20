import { test as base, expect, type Page } from '@playwright/test';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import { attachBusLog, type BusLogCapture } from './bus-log';

/**
 * Polyfill crypto.randomUUID for non-secure-context test environments.
 *
 * The frontend calls `crypto.randomUUID()` (e.g. in busRequest for
 * correlationIds). That API is only defined in secure contexts —
 * HTTPS, `http://localhost`, `http://127.0.0.1`. When tests run against
 * a container IP over HTTP (e.g. `http://192.168.64.60:3000`), it's
 * `undefined` and every emit throws "crypto.randomUUID is not a function".
 *
 * This is also a real product bug — any user accessing the frontend
 * over HTTP from a non-localhost hostname will hit it. TODO: file and
 * fix in the frontend (swap to a uuid library that doesn't require a
 * secure context, or require HTTPS).
 */
const CRYPTO_POLYFILL = `
  if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
    Object.defineProperty(crypto, 'randomUUID', {
      value: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        var v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
      configurable: true,
    });
  }
`;

/**
 * Sign in via the real UI form: Connect → host/port/email/password → submit.
 *
 * Leaves the page on `/en/know/discover` with a live authenticated session.
 * Idempotent: re-invocation on an already-signed-in page is a no-op.
 */
export async function signIn(page: Page): Promise<void> {
  await page.addInitScript(CRYPTO_POLYFILL);

  // Start at the root; the locale redirect drops us on /en and eventually
  // /en/know/discover after session resolution.
  await page.goto('/');

  // If the session is already authenticated (persisted context), the app
  // is already on a know/* route. Detect that and bail.
  if (await isAlreadySignedIn(page)) return;

  const backend = new URL(BACKEND_URL);
  const host = backend.hostname;
  const port = backend.port || (backend.protocol === 'https:' ? '443' : '80');
  const protocol = backend.protocol === 'https:' ? 'https' : 'http';

  // KnowledgeBasePanel auto-opens the Connect form when there are zero
  // registered KBs. When at least one KB is registered, the form is
  // collapsed and we have to click "Add Knowledge Base" first. Race the
  // two states rather than assuming one.
  const emailField = page.getByRole('textbox', { name: /^email$/i });
  const addButton = page.getByRole('button', { name: /add knowledge base/i });

  await expect(async () => {
    const emailVisible = await emailField.isVisible().catch(() => false);
    const addVisible = await addButton.isVisible().catch(() => false);
    expect(emailVisible || addVisible).toBe(true);
  }).toPass({ timeout: 15_000 });

  if (!(await emailField.isVisible().catch(() => false))) {
    await addButton.click();
    await expect(emailField).toBeVisible({ timeout: 5_000 });
  }

  // Fill the form. Fields have labels derived from their placeholder
  // text (the LoginForm uses `placeholder="Host"` etc which Playwright's
  // accessibility tree exposes as textbox names).
  //
  // IMPORTANT: set host BEFORE protocol. Filling the host runs
  // `handleHostChange` which calls `defaultProtocol(host)` and can flip
  // the protocol to HTTPS for IP-like hostnames, overwriting an earlier
  // protocol selection.
  await page.getByRole('textbox', { name: /^host$/i }).fill(host);
  await page.getByRole('combobox').first().selectOption(protocol);
  await page.getByRole('spinbutton').first().fill(port);
  await emailField.fill(E2E_EMAIL);
  await page.getByRole('textbox', { name: /^password$/i }).fill(E2E_PASSWORD);

  // Submit — the primary button in the form is "Connect" (not "Sign in";
  // that's the re-auth form's label).
  await page.getByRole('button', { name: /^connect$/i }).click();

  // Wait until the URL changes OR the form disappears. Either is proof
  // the sign-in was accepted.
  await expect(async () => {
    const signedIn = await isAlreadySignedIn(page);
    expect(signedIn).toBe(true);
  }).toPass({ timeout: 20_000 });
}

/**
 * Best-effort heuristic: we're signed in if the discover route is visible
 * and the sign-in form is not.
 */
async function isAlreadySignedIn(page: Page): Promise<boolean> {
  // No sign-in form visible implies either signed in or still loading.
  const emailInput = page.getByRole('textbox', { name: /^email$/i });
  const emailVisible = await emailInput.isVisible().catch(() => false);
  if (emailVisible) return false;

  // The authenticated Knowledge section uses a /know/ URL and has no
  // sign-in form; that combination is proof-of-auth.
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
export const test = base.extend<{ signedInPage: Page; bus: BusLogCapture }>({
  bus: async ({ page }, use) => {
    const capture = await attachBusLog(page);
    await use(capture);
  },
  signedInPage: async ({ page, bus: _bus }, use) => {
    // Depend on `bus` so the init script runs before signIn. `_bus`
    // isn't referenced here; it just forces fixture ordering.
    await signIn(page);
    await use(page);
  },
});

export { expect };
export type { BusLogCapture } from './bus-log';
