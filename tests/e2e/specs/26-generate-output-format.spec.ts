import { test, expect } from '../fixtures/auth';
import { expectGeneratedAt } from '../fixtures/generated';
import { openConfigureStep, runGeneration } from '../fixtures/generate';

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
    //
    // ORDER IS LOAD-BEARING. Since P4/D11 an untouched Save location is
    // PROPOSED from the title + format, and a proposal always matches — the
    // refusal is reachable only on a hand-edited path. Filling the path FIRST
    // is what makes it hand-edited; select PDF first and the proposal would
    // rewrite the extension to .pdf, no mismatch would exist, and every
    // assertion below would silently test nothing. (Spec 27 pins the
    // untouched-proposal behavior itself.)
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
