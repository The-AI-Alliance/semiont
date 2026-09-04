import { test, expect } from '../fixtures/auth';
import { SemiontClient, resourceId as rid } from '@semiont/sdk';
import { proposeStoragePath, folderOf, getStorageUri } from '@semiont/core';
import { GATEWAY_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import { expectGeneratedAt } from '../fixtures/generated';
import { openConfigureStep, runGeneration } from '../fixtures/generate';
import { signInSession } from '../fixtures/sdk-session';

/**
 * An UNTOUCHED Save location generates to the PROPOSED path (P4/D11).
 *
 * Every other generation spec fills `#wizard-storagePath` — and filling is
 * exactly what marks the field touched, so the whole suite exercised only the
 * hand-edited branch. This spec covers the branch P4 actually changed: the
 * form proposes `<source-folder>/<title-slug><ext>`, the proposal follows the
 * title and the format while untouched, and submitting WITHOUT touching it
 * lands the artifact exactly there. Since P4a the worker has no fallback, so
 * a broken proposal would fail every default-path generation in the product
 * while every other spec stayed green.
 *
 * The expected value is DERIVED from @semiont/core's own proposeStoragePath/
 * folderOf against the source's real descriptor — restating the slug rule
 * here would be a mirror. "Stops following once edited" is pinned at the unit
 * level (ConfigureGenerationStep tests); this spec stays on the wire-reaching
 * branch.
 */

const resourceIdFromUrl = (url: string) => url.split('/').pop()!.split('?')[0]!;

async function sourceStorageUri(id: string): Promise<string> {
  const session = await signInSession();
  const client = session.client;
  try {
    const descriptor = await client.browse.resource(rid(id)).fresh();
    const uri = getStorageUri(descriptor);
    if (!uri) throw new Error(`source ${id} has no storageUri`);
    return uri;
  } finally {
    await session.dispose();
  }
}

test.describe('generate to the proposed save location', () => {
  test('an untouched Save location follows title and format, and the artifact lands at the proposal', async ({ signedInPage: page, bus }) => {
    test.setTimeout(180_000);

    const modal = await openConfigureStep(page, bus);
    const folder = folderOf(await sourceStorageUri(resourceIdFromUrl(page.url())));

    const title = `e2e-27-${Date.now()}`;
    const pathInput = modal.locator('#wizard-storagePath');

    // Typing the TITLE is not touching the path: the proposal follows it.
    await modal.locator('#wizard-title').fill(title);
    await expect(pathInput, 'the proposal derives from source folder + title + format')
      .toHaveValue(proposeStoragePath(folder, title, 'text/markdown'));

    // Switching format re-proposes the extension — which is also why D7's
    // mismatch refusal is unreachable from an untouched form (see spec 26).
    await modal.locator('#wizard-outputFormat').selectOption('text/plain');
    const proposed = proposeStoragePath(folder, title, 'text/plain');
    await expect(pathInput, 'a format switch rewrites the proposed extension').toHaveValue(proposed);
    await expect(modal.locator('#wizard-format-mismatch')).toHaveCount(0);

    // Submit with the path NEVER touched: the proposal is what reaches the
    // worker, and the worker (no fallback since P4a) writes exactly there.
    await runGeneration(modal, bus, 120_000);
    await expectGeneratedAt(title, proposed, 'text/plain');
  });
});
