import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';

/**
 * Settings panel: every control must actually apply its change.
 *
 * The Settings panel (⚙️ in the right toolbar) exposes four prefs —
 * Line Numbers, Theme, Language, Hover Delay. Each one is a fire-and-
 * forget bus emit from `SettingsPanel`:
 *
 *   button click → `semiont.emit('settings:<x>', …)` on the app-scoped
 *   `SemiontBrowser` bus → a `useEventSubscriptions(...)` handler →
 *   the actual state mutation (ThemeContext / useLineNumbers / router).
 *
 * Because the emit and the subscription live in *different* components
 * (the panel emits; the page or ToolbarPanels subscribes), a control can
 * silently break if its subscriber isn't mounted or isn't listening on
 * the bus the panel emits on — while a sibling control keeps working.
 * That's exactly the failure mode this suite guards: Theme and Line
 * Numbers reportedly stopped applying while Language still worked.
 *
 * Each test asserts BOTH halves of the chain so a failure localizes the
 * break:
 *   - the `settings:*` EMIT reaches the bus (the click→emit half), and
 *   - the user-visible outcome changes (the emit→apply half).
 * EMIT-passes-but-outcome-fails ⇒ the subscriber/handler is the culprit,
 * not the button.
 */

/** Open the ⚙️ Settings panel from the right toolbar and wait for it. */
async function openSettings(page: Page) {
  await page.locator('[data-panel="settings"]').click();
  const panel = page.locator('.semiont-settings-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Sign out via the User panel, landing on the unauthenticated layout. */
async function signOut(page: Page) {
  await page.locator('[data-panel="user"]').click();
  await page.getByRole('button', { name: /^sign out$/i }).click();
  // The unauthenticated knowledge layout shows the "signed out" empty state.
  await expect(page.getByText(/you are signed out/i)).toBeVisible({ timeout: 15_000 });
}

/** From Discover, open the first seeded resource and wait for the viewer. */
async function openFirstResource(page: Page) {
  await page.goto('/en/know/discover');
  const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
  await expect(firstCard).toBeVisible({ timeout: 15_000 });
  await firstCard.click();
  await expect(page).toHaveURL(/\/know\/resource\//, { timeout: 10_000 });
  await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
}

test.describe('settings panel', () => {
  test('Theme buttons change the applied theme', async ({ signedInPage: page, bus }) => {
    const panel = await openSettings(page);
    const html = page.locator('html');

    // Drive both directions so a visible transition is observed regardless
    // of the initial (system-resolved) theme. ThemeContext writes the
    // resolved theme to `data-theme` on <html> — that attribute IS the
    // user-visible outcome (the whole app re-skins off it).
    await panel.getByRole('button', { name: 'Dark' }).click();
    await expect(bus.waitForEmit('settings:theme-changed')).resolves.toBeTruthy();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await panel.getByRole('button', { name: 'Light' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');

    // The pressed-state of the buttons must track the applied theme too.
    await expect(panel.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('Line Numbers toggle flips its state', async ({ signedInPage: page, bus }) => {
    const panel = await openSettings(page);
    const toggle = panel.getByRole('switch');

    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();

    await expect(bus.waitForEmit('settings:line-numbers-toggled')).resolves.toBeTruthy();
    // The switch must reflect the new value — the panel re-renders off the
    // `showLineNumbers` prop the subscriber mutates.
    await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  });

  // Control: Language is the sibling control reported as still working.
  // It must keep passing — if it ever regresses, the whole bus path
  // (panel emit → subscriber) is broken, not just one channel.
  test('Language select changes the active locale', async ({ signedInPage: page, bus }) => {
    await expect(page).toHaveURL(/\/en\//);

    const panel = await openSettings(page);
    await panel.locator('#language-select').selectOption('fr');

    await expect(bus.waitForEmit('settings:locale-changed')).resolves.toBeTruthy();
    await expect(page).toHaveURL(/\/fr\//);
  });
});

/**
 * Settings panel while SIGNED OUT — the reported repro.
 *
 * When no KB session is active, `know/layout.tsx` does NOT render the page
 * `<Outlet/>` (where `useEventSubscriptions({'settings:theme-changed',
 * 'settings:line-numbers-toggled'})` lives). It renders
 * `UnauthenticatedKnowledgeLayout`, which mounts the Settings panel and
 * its Theme/Line-Numbers controls but never subscribes to those channels.
 * So the buttons emit to ZERO subscribers — clean console, nothing
 * happens. Language survives because its handler lives inside
 * `ToolbarPanels`, which the unauthenticated layout *does* mount.
 *
 * These tests assert the controls actually apply; they FAIL on the buggy
 * layout and guard the fix (subscribe to theme/line-numbers in the
 * unauthenticated layout, or hoist the subscription somewhere always
 * mounted).
 */
test.describe('settings panel — signed out', () => {
  test('Theme buttons change the applied theme when signed out', async ({ signedInPage: page, bus }) => {
    await signOut(page);
    const panel = await openSettings(page);
    const html = page.locator('html');

    await panel.getByRole('button', { name: 'Dark' }).click();
    // The emit still fires — the button wiring is fine...
    await expect(bus.waitForEmit('settings:theme-changed')).resolves.toBeTruthy();
    // ...but with no subscriber mounted, nothing applies it. This is the bug.
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('Line Numbers toggle flips its state when signed out', async ({ signedInPage: page, bus }) => {
    await signOut(page);
    const panel = await openSettings(page);
    const toggle = panel.getByRole('switch');

    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();

    await expect(bus.waitForEmit('settings:line-numbers-toggled')).resolves.toBeTruthy();
    await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  });

  // Control: Language works even signed out (handler lives in ToolbarPanels,
  // which the unauthenticated layout mounts). This is the "still settable"
  // sibling from the report — it must keep passing.
  test('Language select changes the active locale when signed out', async ({ signedInPage: page, bus }) => {
    await signOut(page);
    const panel = await openSettings(page);
    await panel.locator('#language-select').selectOption('fr');

    await expect(bus.waitForEmit('settings:locale-changed')).resolves.toBeTruthy();
    await expect(page).toHaveURL(/\/fr\//);
  });
});

/**
 * Same panel, opened on the *resource viewer* route. This is the route
 * the bug was reported on, and it differs structurally from Discover:
 *
 *   - Discover's page component (app source) subscribes to
 *     `settings:theme-changed` / `settings:line-numbers-toggled` itself.
 *   - The resource route does NOT — `know/resource/[id]/page.tsx`
 *     delegates *all* events to `ResourceViewerPage`, which lives in the
 *     **built** `@semiont/react-ui` package. Only Language is handled by
 *     the app-source `ToolbarPanels`.
 *
 * So on this route Theme/Line Numbers ride entirely on react-ui's dist
 * while Language rides on app source. If those two disagree (e.g. the
 * package wasn't rebuilt after a src change), Theme/Line Numbers break
 * here while Language keeps working — the exact reported symptom.
 */
test.describe('settings panel — resource viewer', () => {
  test('Theme buttons change the applied theme on a resource', async ({ signedInPage: page, bus }) => {
    await openFirstResource(page);
    const panel = await openSettings(page);
    const html = page.locator('html');

    await panel.getByRole('button', { name: 'Dark' }).click();
    await expect(bus.waitForEmit('settings:theme-changed')).resolves.toBeTruthy();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await panel.getByRole('button', { name: 'Light' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('Line Numbers toggle flips its state on a resource', async ({ signedInPage: page, bus }) => {
    await openFirstResource(page);
    const panel = await openSettings(page);
    const toggle = panel.getByRole('switch');

    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();

    await expect(bus.waitForEmit('settings:line-numbers-toggled')).resolves.toBeTruthy();
    await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  });

  // Control: Language must keep working on the resource route too.
  test('Language select changes the active locale on a resource', async ({ signedInPage: page, bus }) => {
    await openFirstResource(page);
    const panel = await openSettings(page);
    await panel.locator('#language-select').selectOption('fr');

    await expect(bus.waitForEmit('settings:locale-changed')).resolves.toBeTruthy();
    await expect(page).toHaveURL(/\/fr\//);
  });
});
