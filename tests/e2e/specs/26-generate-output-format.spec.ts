import { test, expect, type BusLogCapture } from '../fixtures/auth';
import type { Locator, Page } from '@playwright/test';
import { openResourceByName } from '../fixtures/discover';
import { expectGeneratedAt } from '../fixtures/generated';

/**
 * The Format dropdown decides what the worker writes — and where.
 *
 * GENERATION-OUTPUT-FORMAT added `#wizard-outputFormat` to both Generate
 * flows. Specs 09 and 16 exercise the flows themselves, but always at the
 * default (`text/markdown`), so nothing in the suite proves that choosing a
 * different row changes the artifact. This file covers the two rows that were
 * added and the refusal that guards them.
 *
 * Three seams, none reachable from unit tests:
 *
 *   1. **text/plain** — the dropdown value reaches the worker and the
 *      descriptor names it. A regression here is silent: markdown rendered as
 *      plain text still reads fine, so only the descriptor catches it.
 *   2. **application/pdf** — the worker's Typst compile-and-repair loop runs
 *      for real. This is the only place in the suite that exercises it.
 *   3. **the mismatch refusal (D7)** — a `.md` path with PDF selected must
 *      disable the primary action and say why, INLINE beside Save location.
 *      Asserted on the same open modal as (1) rather than in its own test:
 *      the configure step only mounts after a gather round-trip, so a
 *      separate test would spend a full LLM call to check a form-state rule.
 *
 * Both tests use the resource flow (Info panel → Generate), which needs only a
 * resource — unlike the annotation flow, which needs an unresolved reference
 * and so is coupled to specs 05/06 running first. The format field is shared
 * by both flows (one `ConfigureGenerationStep`), so covering it once covers it.
 *
 * PDF is in the DEFAULT tier by explicit choice (user, 2026-08-24), not
 * `@slow`. A two-page compile finished well inside the generation budget
 * during the P3 live gate. If it ever starts crowding the budget, the fix is
 * to tag it `@slow` — not to widen the timeout.
 */

/**
 * A NAMED text seed, not Discover's first card. This file's own tests generate
 * resources, and every generated resource lands newest-first — so "first card"
 * would hand the second test whatever the first test just wrote, and eventually
 * a `.pdf`. Spec 09 documents this breakage twice over. Generating FROM a
 * resource consumes nothing, so both tests can share one seed.
 */
const SOURCE = 'Photosynthesis Overview';

/** Open the seed and drive its Generate modal to the configure step. */
async function openConfigureStep(page: Page, bus: BusLogCapture): Promise<Locator> {
  await openResourceByName(page, SOURCE);
  await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

  await page.locator('button[data-panel="info"]').click();
  const infoPanel = page.locator('.semiont-resource-info-panel');
  await expect(infoPanel).toBeVisible({ timeout: 10_000 });
  // ✨ is literal in ResourceInfoPanel; the word "Generate" is translated and
  // also names the AssistShell section header. See spec 16.
  await infoPanel.getByRole('button', { name: /✨.*generate/i }).click();

  const modal = page.locator('.semiont-search-modal__panel--gather');
  await expect(modal).toBeVisible({ timeout: 10_000 });

  bus.clear();
  await modal.getByRole('button', { name: /gather/i }).click();
  await bus.expectRequestResponse('gather:resource-requested', 'gather:resource-complete', 60_000);

  // ConfigureGenerationStep mounts only under `gatherFired && gatherContext`.
  await expect(modal.locator('#wizard-title')).toBeAttached({ timeout: 30_000 });
  return modal;
}

/** Submit and wait out the generation, failing loudly on `job:fail`. */
async function runGeneration(modal: Locator, bus: BusLogCapture, timeout: number): Promise<void> {
  bus.clear();
  await modal.getByRole('button', { name: /generate/i }).last().click();

  const { request } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
  expect(request.cid, 'generation job:create must carry a correlationId').toBeTruthy();

  const outcome = await Promise.race([
    bus.waitForRecv('job:complete', { timeout }).then(() => 'complete' as const),
    bus.waitForRecv('job:fail', { timeout }).then(() => 'fail' as const),
  ]);
  if (outcome === 'fail') {
    throw new Error(
      'Expected job:complete, got job:fail. Recent bus entries:\n' +
        bus.entries.slice(-15).map((e) => `  [${e.op}] ${e.channel} ${e.raw}`).join('\n'),
    );
  }
}

test.describe('generate output format', () => {
  test('a mismatched extension is refused, and text/plain yields a text/plain resource at the typed path', async ({ signedInPage: page, bus }) => {
    test.setTimeout(180_000);

    const modal = await openConfigureStep(page, bus);
    const runId = Date.now();
    const title = `e2e-spec-26-plain-${runId}`;
    const storagePath = `generated/e2e-26-${runId}.txt`;

    await modal.locator('#wizard-title').fill(title);
    const pathInput = modal.locator('#wizard-storagePath');
    const formatSelect = modal.locator('#wizard-outputFormat');
    const generateBtn = modal.getByRole('button', { name: /generate/i }).last();

    // ── D7: PDF selected, `.md` typed → refused inline, action disabled ────
    // The message is i18n'd, so assert the element (`#wizard-format-mismatch`,
    // role=alert) and the aria wiring rather than its words.
    await pathInput.fill(`generated/e2e-26-${runId}.md`);
    await formatSelect.selectOption('application/pdf');

    const mismatch = modal.locator('#wizard-format-mismatch');
    await expect(mismatch, 'a format/extension mismatch says why, inline').toBeVisible();
    await expect(mismatch).toHaveAttribute('role', 'alert');
    await expect(pathInput, 'the Save location field is the one marked invalid').toHaveAttribute('aria-invalid', 'true');
    await expect(pathInput).toHaveAttribute('aria-describedby', 'wizard-format-mismatch');
    await expect(generateBtn, 'the refusal disables the primary action').toBeDisabled();

    // ── Correct the pair → the refusal clears and submission is allowed ────
    await formatSelect.selectOption('text/plain');
    await pathInput.fill(storagePath);
    await expect(mismatch).toHaveCount(0);
    await expect(pathInput).toHaveAttribute('aria-invalid', 'false');
    await expect(generateBtn).toBeEnabled();

    await runGeneration(modal, bus, 120_000);
    await expectGeneratedAt(title, storagePath, 'text/plain');
  });

  test('application/pdf yields a PDF resource at the typed path', async ({ signedInPage: page, bus }) => {
    test.setTimeout(240_000);

    const modal = await openConfigureStep(page, bus);
    const runId = Date.now();
    const title = `e2e-spec-26-pdf-${runId}`;
    const storagePath = `generated/e2e-26-${runId}.pdf`;

    await modal.locator('#wizard-title').fill(title);
    await modal.locator('#wizard-outputFormat').selectOption('application/pdf');
    await modal.locator('#wizard-storagePath').fill(storagePath);
    await expect(modal.locator('#wizard-format-mismatch'), 'a matching pair is not refused').toHaveCount(0);

    // Longer than the markdown budget: this waits on a Typst compile (and, if
    // the first pass does not compile, the worker's repair round-trip) on top
    // of the inference call.
    await runGeneration(modal, bus, 180_000);
    await expectGeneratedAt(title, storagePath, 'application/pdf');
  });
});
