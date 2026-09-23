import { test, expect } from '../fixtures/auth';
import { E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

/**
 * Smoke test: sign out, then sign back in against the same KB, and
 * confirm the fresh session's bus + SSE + client are wired correctly.
 *
 * Regression target (VMs-from-Session refactor, Stages B-C): the session
 * lifetime is owned by `SemiontBrowser.setActiveKb` — `signOut`
 * disposes the old `SemiontSession` (which closes its client, completes
 * its observables, and unsubscribes the SessionStorage listener), and
 * `signIn` constructs a fresh session with a new `SemiontClient`
 * that spins up its own EventBus and its own SSE ActorStateUnit. If any part
 * of the new session wiring regresses — `client.emit` routing to a
 * dead bus, SSE not reconnecting on the new client, storage adapter
 * not writing the token — a post-sign-in action will silently fail
 * instead of round-tripping through the gateway.
 *
 * This test asserts protocol-level health via
 * `bus.expectRequestResponse` on the second session, which is the
 * strongest signal that the dispose/reconstruct path is clean.
 *
 * The re-auth half goes through the issuer. Since identity moved out of
 * the gateway, the Browser has no password field to type into: a
 * registered KB whose session ended offers one button back to where its
 * credentials live (`KnowledgeBasePanel.tsx` `handleReauth` →
 * `beginSignIn` → `window.location.assign`).
 */
test.describe('sign out and sign back in', () => {
  test('a fresh session after sign-out round-trips through the bus', async ({ signedInPage: page, bus }) => {
    // First session exists. Navigate somewhere we can hit the bus from.
    await page.goto('/en/know/discover');
    await expect(page).toHaveURL(/\/know\/discover/);

    // The per-KB sign-out control renders only for `status ===
    // 'authenticated'` (KnowledgeBasePanel.tsx), which makes its absence
    // and return exact readings of the session's state — not a proxy for
    // one. UserPanel has a "Sign Out" of its own that also navigates, so
    // scope this to the KB row.
    const kbRow = page.locator('.semiont-panel-item--clickable').first();
    const signOutButton = kbRow.getByTitle(/^sign out$/i);
    await expect(signOutButton).toBeVisible({ timeout: 10_000 });
    await signOutButton.click();

    // Sign-out landed: the KB is still registered, its session is not.
    await expect(signOutButton).toBeHidden({ timeout: 10_000 });

    // Clicking a KB with no session opens the re-auth prompt rather than
    // activating it (`handleKbClick`).
    await kbRow.click();
    const reauthButton = page.getByRole('button', { name: /^sign in$/i });
    await expect(reauthButton).toBeVisible({ timeout: 10_000 });
    await reauthButton.click();

    // Credentials are entered at the issuer, never here. Signing out
    // revokes the refresh token but need not end Keycloak's own SSO
    // session, so the issuer is free to either prompt or send us
    // straight back. Both are correct; race them rather than assuming.
    const username = page.locator('#username');
    await expect(async () => {
      const prompted = await username.isVisible().catch(() => false);
      const returned = await signOutButton.isVisible().catch(() => false);
      expect(prompted || returned).toBe(true);
    }).toPass({ timeout: 20_000 });

    if (await username.isVisible().catch(() => false)) {
      await username.fill(E2E_EMAIL);
      await page.locator('#password').fill(E2E_PASSWORD);
      await page.locator('#kc-login').click();
    }

    // The second session is live once the KB reads authenticated again.
    // Waiting on this rather than on the URL matters: the URL already
    // matches from the signed-out state, so asserting it would pass
    // immediately and the `goto` below would abort the still-in-flight
    // callback.
    await expect(signOutButton).toBeVisible({ timeout: 30_000 });
    bus.clear();

    await page.goto('/en/know/discover');
    await expect(page).toHaveURL(/\/know\/discover/);

    // Open the first resource. This fires
    // `browse:resource-requested` and expects `browse:resource-result`
    // on the new session's bus — exactly the round-trip 02 relies on,
    // but here proving it works after a dispose/reconstruct cycle.
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();

    await bus.expectRequestResponse('browse:resource-requested', 'browse:resource-result', 30_000);
  });
});
