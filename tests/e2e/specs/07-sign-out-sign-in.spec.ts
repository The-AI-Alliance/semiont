import { test, expect } from '../fixtures/auth';
import { E2E_PASSWORD } from '../playwright.config';

/**
 * Smoke test: sign out, then sign back in against the same KB, and
 * confirm the fresh session's bus + SSE + client are wired correctly.
 *
 * Regression target (VMs-from-Session refactor, Stages B-C): the session
 * lifetime is now owned by `SemiontBrowser.setActiveKb` — `signOut`
 * disposes the old `SemiontSession` (which closes its client, completes
 * its observables, and unsubscribes the SessionStorage listener), and
 * `signIn` constructs a fresh session with a new `SemiontApiClient`
 * that spins up its own EventBus and its own SSE ActorVM. If any part
 * of the new session wiring regresses — `client.emit` routing to a
 * dead bus, SSE not reconnecting on the new client, storage adapter
 * not writing the token — a post-sign-in action will silently fail
 * instead of round-tripping through the backend.
 *
 * This test asserts protocol-level health via
 * `bus.expectRequestResponse` on the second session, which is the
 * strongest signal that the dispose/reconstruct path is clean.
 */
test.describe('sign out and sign back in', () => {
  test('a fresh session after sign-out round-trips through the bus', async ({ signedInPage: page, bus }) => {
    // First session exists. Navigate somewhere we can hit the bus from.
    await page.goto('/en/know/discover');
    await expect(page).toHaveURL(/\/know\/discover/);

    // Sign out via the KnowledgeBasePanel's per-KB sign-out button.
    // (UserPanel's "Sign Out" also works but also navigates, which
    // confuses the fixture's URL assertions.) KnowledgeBasePanel's
    // Sign Out is inside the KB list item; click it then wait for the
    // sign-in form to reappear.
    const kbPanel = page.getByRole('button', { name: /knowledge bases/i });
    // Expand the Knowledge Bases panel if not already visible. The
    // panel title is a toggle; the connected KB row is visible once
    // expanded.
    if (await kbPanel.isVisible().catch(() => false)) {
      await kbPanel.click();
    }

    // Hover over the connected KB to reveal its sign-out button.
    // KnowledgeBasePanel's sign-out button has title/aria-label from
    // the i18n "signOut" key; match on that tooltip.
    const signOutButton = page.getByTitle(/^sign out$/i).first();
    await expect(signOutButton).toBeVisible({ timeout: 10_000 });
    await signOutButton.click();

    // After sign-out, the KB is still registered but has no active
    // session. The panel collapses back to showing status "signed-out"
    // for that KB and a Sign in re-auth form becomes available on click.
    // The main content area swaps to the "no active session" empty state.
    // Assert that no active session exists by waiting for the sign-in
    // form (Password field) to become reachable via a click.
    // Actually simpler: the password field appears once we click the KB
    // to reauth.
    const kbRow = page.getByRole('button', { name: /kb a$/i }).first();
    // Click the KB to trigger re-auth flow. If the row name differs
    // across fixtures, fall back to the first non-sign-out button in
    // the panel list.
    const kbEntries = page.locator('.semiont-panel-item--clickable');
    await expect(kbEntries.first()).toBeVisible({ timeout: 10_000 });
    await kbEntries.first().click();

    const passwordInput = page.getByPlaceholder('Password');
    await expect(passwordInput).toBeVisible({ timeout: 10_000 });

    // Re-auth. Fill password and submit.
    await passwordInput.fill(E2E_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();

    // Wait for the password form to close (session activated). Just
    // asserting `toHaveURL(/know/)` is insufficient because the URL
    // already matches from the signed-out state — asserting it passes
    // immediately, and a subsequent `page.goto` would abort the
    // still-in-flight sign-in POST.
    await expect(passwordInput).toBeHidden({ timeout: 20_000 });
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
