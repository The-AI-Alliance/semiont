/**
 * A session becoming live opens the Knowledge Base panel.
 *
 * `useKbPanelOnLogin` (apps/browser/src/hooks/useKbPanelOnLogin.ts) exists for a
 * case an interactive sign-in CANNOT exercise, and the hook says so itself: you
 * reach the sign-in control through the KB panel, so after signing in you happen
 * to already be on it. The defect was a session **restored at launch** — nothing
 * reacted to it appearing, and you landed on whatever panel the app closed with.
 *
 * So asserting the panel right after `signedInPage` would pass whether or not the
 * hook exists. The reload is the whole test: it is what turns the fixture's
 * session into a restored one, which is the render the hook has to catch.
 *
 * Settings is the deliberate choice for the "other panel". The signed-out
 * layout's one-shot corrector (`know/layout.tsx:104`) redirects non-viable
 * panels to knowledge-base but **exempts settings** — so a test that closed on
 * any other panel could be satisfied by the corrector alone, and would pass with
 * the hook deleted. Settings is the one panel the corrector will not move.
 */

import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';

/** The toolbar control for a panel, which carries the active state. */
const control = (page: Page, panel: string) => page.locator(`[data-panel="${panel}"]`);

/** The Knowledge Base panel proper — its header names it. */
const kbPanel = (page: Page) =>
  page.locator('.semiont-panel').filter({ hasText: 'Knowledge Bases' });

test.describe('knowledge base panel on a live session', () => {
  test('a session restored at launch opens the KB panel, over the panel the app closed with', async ({
    signedInPage: page,
  }) => {
    // Land somewhere else, deliberately. Settings survives the layout's
    // corrector, so if it is still active after the reload the hook did nothing.
    await control(page, 'settings').click();
    await expect(page.locator('.semiont-settings-panel')).toBeVisible();
    await expect(control(page, 'settings')).toHaveAttribute('aria-pressed', 'true');

    // Restore the session at launch — the render the hook exists for.
    const urlBeforeReload = page.url();
    await page.reload();
    await expect(page).toHaveURL(urlBeforeReload);

    // The KB panel wins, with no interaction at all.
    await expect(control(page, 'knowledge-base')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 15_000,
    });
    await expect(kbPanel(page)).toBeVisible();
    await expect(
      control(page, 'settings'),
      'the panel the app closed with must not survive a restored session',
    ).toHaveAttribute('aria-pressed', 'false');
  });
});
