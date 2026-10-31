import { test, expect } from '@playwright/test';
import { MARK_MOTIVATIONS, type EngineWithLimits, type JobFilter } from '@semiont/core';
import { signInSession } from '../fixtures/sdk-session';

/**
 * Smoke test: the KB's engines, `browse.engines()`, against a live stack — plus
 * the attribution loop (the engine software's work names is one of them).
 *
 * Pure **SDK round-trip** (no browser), per the spec-15 pattern: the consumer
 * is chat's delegation chooser, an SDK caller.
 *
 * What it pins:
 *
 * 1. **Stack freshness gate.** `browse.engines()` must answer AT ALL. A stack
 *    predating the `browse:engines-*` channels rejects the emit with "Unknown
 *    channel: browse:engines-requested" — an environment verdict, not a feature
 *    verdict; the distinctive error below says "rebuild the stack", not "the
 *    feature is broken".
 * 2. **Shape.** Every entry's engine is a `provider` and a `model`, and nothing
 *    more: an engine is not a principal, and carries no identity. Each engine is
 *    listed once.
 * 3. **Each job has one engine.** Each job a claim can name (a `mark` job of
 *    each motivation, and a `yield` job) appears in EXACTLY one entry's `jobs`
 *    (the Inference document gives each job one engine, and the list holds each
 *    engine once), each named as a claim names it. Entries without `jobs`
 *    (engines only the librarian's actors ask) are legal.
 * 4. **No secret material.** The reply carries no `apiKey`/endpoint config.
 * 5. **The attribution loop.** After a real delegated job, each `generator`
 *    stamped on the created annotations names an agent's DID — the worker that
 *    did the work — and the engine it used, which is one of the KB's engines:
 *    engines stated ⊇ engines used. An engine used but not stated is the
 *    stated-vs-actual discrepancy this check exists to surface.
 *
 * Auth note: the e2e harness's only user is the seeded admin. The load-bearing
 * property is that the channel needs no ADMIN gate (the Browser's bus handlers
 * consult no roles — nothing admin-shaped exists on this path), so the admin
 * session exercises exactly what a non-admin one would. A true non-admin
 * session becomes worth wiring when there is something admin-only to withhold.
 *
 * Self-seeding: creates its own resource for the delegated job. Slow: the
 * attribution leg waits on a real LLM highlight pass (spec-06/11 class).
 */

/** A job as a claim names it, in words: `mark.<motivation>`, or `yield`. */
const named = (filter: JobFilter): string =>
  filter.jobType === 'mark' ? `mark.${filter.params.motivation}` : filter.jobType;

/** Every job a claim can name: a `mark` job of each motivation, and a `yield` job. */
const JOBS = [...MARK_MOTIVATIONS.map((motivation) => `mark.${motivation}`), 'yield'];

/** An engine, as a key: `<provider> <model>`. */
const engineKey = (provider: string | undefined, model: string | undefined): string => `${provider} ${model}`;

test.describe('the engines (browse.engines)', () => {
  test('each engine is listed once, and the engine a worker\'s work names is one of them', { tag: ['@model'] }, async () => {
    test.setTimeout(120_000);

    const opened = await signInSession();

    const client = opened.session.client;

    try {
      // ── 1. Freshness gate: the channel must exist on the running stack ──
      let entries: EngineWithLimits[];
      try {
        // `.fresh()` is the explicit one-shot read: a CacheObservable is not awaitable.
        entries = await client.browse.engines().fresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `STACK FRESHNESS GATE: browse.engines() did not answer (${msg}). ` +
            `If this is "Unknown channel: browse:engines-requested", the running stack ` +
            `predates the browse:engines-* channels — rebuild/redeploy before judging the engines.`,
        );
      }

      // ── 2. Shape ──
      expect(entries.length, 'the Inference document states engines → the list is non-empty').toBeGreaterThan(0);

      const engines = new Set<string>();
      for (const entry of entries) {
        expect(entry.engine.provider, 'an engine names its provider').toBeTruthy();
        expect(entry.engine.model, 'an engine names its model').toBeTruthy();
        expect(Object.keys(entry.engine).sort(), 'an engine is a provider and a model, with no identity').toEqual(['model', 'provider']);
        engines.add(engineKey(entry.engine.provider, entry.engine.model));
      }
      expect(engines.size, 'each engine is listed once').toBe(entries.length);

      // ── 3. Each job has one engine ──
      const jobEngines = new Map<string, number>();
      for (const entry of entries) {
        for (const filter of entry.jobs ?? []) {
          const job = named(filter);
          expect(JOBS, `"${job}" is a job a claim can name`).toContain(job);
          jobEngines.set(job, (jobEngines.get(job) ?? 0) + 1);
        }
      }
      for (const job of JOBS) {
        expect(
          jobEngines.get(job) ?? 0,
          `"${job}" has exactly one engine (the Inference document gives each job one; the list holds each engine once)`,
        ).toBe(1);
      }

      // ── 4. No secret material on the wire ──
      const raw = JSON.stringify(entries);
      expect(raw.includes('apiKey'), 'reply must not leak inference config secrets').toBe(false);

      // ── 5. Attribution loop: the engine a real worker's work names ∈ the engines ──
      const rid = (
        await client.yield.resource({
          name: 'Engine Attribution',
          storageUri: 'file://e2e/engine-attribution.txt',
          file: Buffer.from(
            'Photosynthesis converts sunlight into chemical energy. ' +
              'The Calvin cycle fixes carbon dioxide into glucose. ' +
              'Chlorophyll absorbs red and blue light most strongly.',
            'utf-8',
          ),
          format: 'text/plain',
          language: 'en',
        })
      ).resourceId;

      const done = await client.mark.delegate(rid, { motivation: 'highlighting', sourceLanguage: 'en' });
      // Awaited, a delegation resolves on the job's completion. A mark job's
      // result is its counts or a decline; the counts say it did its work.
      expect(done.result !== undefined && 'found' in done.result, 'the highlighting job reports its counts').toBe(true);

      // The worker stamps `generator` (single or pipeline array) on what it
      // created. Poll for projection delivery, then assert the engine's membership.
      await expect
        .poll(
          async () =>
            (await client.browse.annotations(rid).fresh()).some((a) => a.generator !== undefined),
          { timeout: 30_000 },
        )
        .toBe(true);

      const generated = (await client.browse.annotations(rid).fresh()).filter((a) => a.generator !== undefined);
      expect(generated.length, 'the delegated job produced ≥1 generator-stamped annotation').toBeGreaterThan(0);

      for (const ann of generated) {
        const generators = Array.isArray(ann.generator) ? ann.generator : [ann.generator!];
        for (const gen of generators) {
          expect(gen['@type'], 'a worker\'s work is a software agent\'s').toBe('Software');
          expect(gen['@id'], 'generator names the agent that did the work').toMatch(/:agents:/);
          const software = gen as { provider?: string; model?: string };
          expect(
            engines.has(engineKey(software.provider, software.model)),
            `the engine ${engineKey(software.provider, software.model)} is one of the KB's engines — a miss is a ` +
              `stated-vs-actual discrepancy`,
          ).toBe(true);
        }
      }
    } finally {
      opened.dispose();
    }
  });
});
