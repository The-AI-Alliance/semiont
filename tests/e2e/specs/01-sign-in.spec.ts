import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: sign-in lands on the knowledge section with an active
 * session.
 *
 * Entry coverage: frontend bootstrap, per-KB session creation, token
 * minting, initial SSE subscribe. If this test fails, nothing else can
 * pass.
 */
test.describe('sign in', () => {
  test('signs in with email/password and lands on the knowledge section', async ({ signedInPage: page }) => {
    await expect(page).toHaveURL(/\/know\//);

    // The authenticated layout renders a Toolbar and Footer that the
    // unauthenticated layout doesn't. No need to assert deep UI; "not the
    // sign-in form" + "on a /know URL" is sufficient smoke.
    const passwordInput = page.getByPlaceholder('Password');
    await expect(passwordInput).toBeHidden();
  });
});
