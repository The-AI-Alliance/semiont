import { test, expect } from '../fixtures/auth';
import { openResourceByName } from '../fixtures/discover';
import { buildLargeDocument } from '../fixtures/large-document';
import { signInSession } from '../fixtures/sdk-session';

/**
 * The cancel control of a delegated job's progress display, end to end: the
 * control cancels the job it names, says it was pressed until the job ends,
 * and the display ends in its cancelled form, which closes back to the form.
 *
 * Nothing announces a cancellation. A running `mark` job stops after the piece
 * it is working on, and the display learns that it did from the job's status,
 * which its follower asks for once the job has said nothing for `jobSilenceMs`.
 * So between the click and the cancelled ending there is one model call and
 * about fifteen seconds of silence and polling.
 *
 * ── DEFAULT OFF (@slow) ────────────────────────────────────────────────────
 *
 * Tagged `@slow`, so `npm test` leaves it out. Run it deliberately:
 *
 *     npm run test:slow -- -g "cancelling a delegated job"
 *
 * Why: the job must still be running when the control is pressed, so the
 * document is spec 21's chunk-forcing one (~400 KB, many pieces, about eight
 * minutes to annotate whole), and the job is cancelled after its first
 * report. A small document can finish before the cancellation takes effect,
 * and then the spec would prove nothing.
 */

const STAMP = `${Date.now().toString(36)}`;
const RESOURCE_NAME = `Cancel Doc ${STAMP}`;

test.describe('cancelling a delegated job', () => {
  test('the control cancels a running mark job, and the display ends cancelled', { tag: ['@slow'] }, async ({ signedInPage: page, bus }) => {
    test.setTimeout(900_000);

    const opened = await signInSession();
    try {
      await opened.session.client.yield.resource({
        name: RESOURCE_NAME,
        storageUri: `file://e2e/cancel-doc-${STAMP}.txt`,
        file: Buffer.from(buildLargeDocument(400_000), 'utf-8'),
        format: 'text/plain',
        language: 'en',
      });
    } finally {
      opened.dispose();
    }

    await openResourceByName(page, RESOURCE_NAME);

    // Annotate mode, then Annotations → References, as spec 06 does.
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();
    await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^annotations$/i }).click();
    const referencesTab = page.getByRole('button', { name: '🔵', exact: true });
    await expect(referencesTab).toBeVisible({ timeout: 10_000 });
    if ((await referencesTab.getAttribute('aria-pressed')) !== 'true') await referencesTab.click();
    const delegateToggle = page.getByRole('main').getByRole('button', { name: /annotate references/i }).first();
    await expect(delegateToggle).toBeVisible({ timeout: 10_000 });
    if ((await delegateToggle.getAttribute('aria-expanded')) !== 'true') await delegateToggle.click();

    const conceptChip = page
      .locator('.semiont-delegate-widget__chips .semiont-chip--selectable')
      .filter({ hasText: /concept/i });
    await expect(conceptChip).toBeVisible({ timeout: 10_000 });
    await conceptChip.click();
    await expect(conceptChip).toHaveAttribute('data-selected', 'true');

    bus.clear();
    const submitBtn = page.locator('button[data-variant="delegate"][data-type="reference"]');
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();
    await bus.expectRequestResponse('job:create', 'job:created', 30_000);

    const control = page.locator('[data-testid="semiont-delegate-control"]');
    const status = page.locator('[data-testid="semiont-delegate-status"]');
    const fill = page.locator('.semiont-delegate-progress .semiont-progress-bar__fill');

    // The control is there once the queue has named the job. The subject line
    // ("Entity type: Concept") comes with the job's first report: from then on
    // the job is running, on the first of many pieces.
    await expect(control).toHaveAccessibleName('Cancel', { timeout: 30_000 });
    await expect(page.locator('[data-testid="semiont-delegate-subject"]')).toBeVisible({ timeout: 300_000 });

    bus.clear();
    await control.click();
    // From the click until the job ends, the control says it was pressed and
    // cannot be pressed again.
    await expect(control).toBeDisabled();
    await expect(control).toHaveAccessibleName('Cancelling...');
    // The queue answered the request.
    await bus.expectRequestResponse('job:cancel-requested', 'job:cancel-ok', 30_000);

    // The job ends cancelled: its display stays to say so, with the bar where
    // the job stopped, and the control closes it.
    await expect(status).toHaveText('Cancelled', { timeout: 600_000 });
    await expect(control).toBeEnabled();
    await expect(control).toHaveAccessibleName('Close');
    await expect(fill).not.toHaveAttribute('style', /width:\s*100%/);

    await control.click();
    await expect(status).toHaveCount(0);
    await expect(submitBtn).toBeVisible();
  });
});
