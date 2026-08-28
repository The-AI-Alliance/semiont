import { expect, type BusLogCapture } from './auth';
import type { Locator, Page } from '@playwright/test';
import { openResourceByName } from './discover';

/**
 * A NAMED text seed, not Discover's first card. The generation specs create
 * resources, and every generated resource lands newest-first — so "first card"
 * would hand a later test whatever an earlier test just wrote, and eventually
 * a `.pdf`. Spec 09 documents this breakage twice over. Generating FROM a
 * resource consumes nothing, so every spec can share one seed.
 */
export const GENERATE_SOURCE = 'Photosynthesis Overview';

/** Open the seed and drive its Generate modal to the configure step. */
export async function openConfigureStep(page: Page, bus: BusLogCapture): Promise<Locator> {
  await openResourceByName(page, GENERATE_SOURCE);
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
export async function runGeneration(modal: Locator, bus: BusLogCapture, timeout: number): Promise<void> {
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
