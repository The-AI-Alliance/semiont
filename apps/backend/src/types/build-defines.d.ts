/**
 * Build-Time Define Declarations
 *
 * Values substituted into the bundle by the bundler rather than read at
 * runtime. Every build path must supply each one:
 *
 * - `tsup.config.ts` — the production bundle (`npm run build`, `npm run dev`)
 * - `vitest.config.mjs` / `vitest.integration.config.mjs` — tests
 *
 * A build path that forgets a define produces a ReferenceError at first use,
 * not a silent fallback. That is deliberate: a wrong version is worse than a
 * loud failure.
 */

/**
 * The package version this bundle was built from — `apps/backend/package.json`,
 * which `scripts/release/version.mjs` keeps in sync with `version.json`.
 *
 * Reported by `GET /api/health`.
 */
declare const __SEMIONT_VERSION__: string;
