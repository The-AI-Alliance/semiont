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
 * That fails in the least helpful way possible: a spec that passes alone fails
 * in the suite, at `expect(card).toBeVisible()`, reporting `element(s) not found`
 * for a resource that is present, visible, and one search away. It reads as a
 * product defect in whatever the spec is actually testing, on a *fresh, empty*
 * KB too, and the position in the run is the only variable.
 *
 * Searching sidesteps the window entirely: the query goes to the server
 * (`SEARCH_LIMIT = 20`, matched on name, storage URI and entity types), so the
 * answer does not depend on how many resources the suite happened to create
 * beforehand. It is also what the search box is for, which makes it the more
 * honest gesture to be testing.
 *
 * **A `.first()` card lookup is only safe when the spec is genuinely indifferent
 * to WHICH resource it gets — including its media type.** A spec that takes
 * the first card and then waits for `.cm-content`, which mounts only for
 * text-bearing resources, fails with `element(s) not found` once a PDF is the
 * newest resource and Discover puts it first — indistinguishable from a real
 * defect in manual annotation.
 *
 * So the rule is about the assertion, not the window: if a spec asserts anything
 * that only holds for a particular KIND of resource (CodeMirror for text, the
 * page rail for PDFs), it must name the resource it wants. Specs 02 and 03 are
 * fine on `.first()` because they only assert that *something* opens.
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
