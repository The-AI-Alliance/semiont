import { expect, type Page } from '@playwright/test';

/**
 * Open a seeded resource by name from Discover.
 *
 * **Why this is not just `getByRole('button', { name: /open resource: x/i })`.**
 * Discover's landing list is `recent`, and recent is capped at
 * `RECENT_LIMIT = 10` newest-first (`resource-discovery/state/discover-state-unit.ts`).
 * The suite *creates* resources as it runs — specs 09 and 16 generate derived
 * ones — and each is newer than every seed. So the seeds march down the list and
 * fall off the end partway through a full run.
 *
 * That failed in the least helpful way possible: a spec that passes alone fails
 * in the suite, at `expect(card).toBeVisible()`, reporting `element(s) not found`
 * for a resource that is present, visible, and one search away. It reads as a
 * product regression in whatever the spec was actually testing. Measured
 * 2026-08-06: specs 20/22/23 failed exactly this way on a *fresh, empty* KB while
 * passing in isolation, and the position in the run was the only variable —
 * spec 14 (early) passed, specs 20/22/23 (late) did not, and spec 24 passed
 * because its seed is the newest of the PDFs and had not yet fallen off.
 *
 * Searching sidesteps the window entirely: the query goes to the server
 * (`SEARCH_LIMIT = 20`, filtered by name), so the answer does not depend on how
 * many resources the suite happened to create beforehand. It is also what the
 * search box is for, which makes it the more honest gesture to be testing.
 *
 * **A `.first()` card lookup is only safe when the spec is genuinely indifferent
 * to WHICH resource it gets — including its media type.** An earlier revision of
 * this note said generic `.first()` lookups "do NOT need this"; that was wrong,
 * and it cost a debugging cycle on 2026-08-06. Specs 04, 05 and 09 took the
 * first card and then waited for `.cm-content`, which mounts only for
 * text-bearing resources. A 28-page PDF uploaded to the KB became the newest
 * resource, Discover put it first, and all three failed with `element(s) not
 * found` — indistinguishable from a real regression in manual annotation.
 *
 * So the rule is about the assertion, not the window: if a spec asserts anything
 * that only holds for a particular KIND of resource (CodeMirror for text, the
 * page rail for PDFs), it must name the resource it wants. Specs 02 and 03 are
 * still fine on `.first()` because they only assert that *something* opens.
 */
export async function openResourceByName(page: Page, name: string): Promise<void> {
  await page.goto('/en/know/discover');

  // The input is labelled from an i18n string, so it is reached by its class —
  // stable across locales, and this suite only ever runs under /en/ anyway.
  const search = page.locator('.semiont-card__search-input');
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.fill(name);

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const card = page.getByRole('button', { name: new RegExp(`^open resource:\\s*${escaped}`, 'i') }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
}
