import { test, expect } from '@playwright/test';
import { MARK_MOTIVATIONS, kbDid, type components, type JobFilter } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';
import { GATEWAY_URL } from '../playwright.config';
import { signInSession } from '../fixtures/sdk-session';

/**
 * Smoke test: the worker's `/health` vitals against a live stack. Pure
 * **HTTP + SDK round-trip** (no browser), per the spec-15/18 pattern.
 *
 * Why this exists: a `/health` that answers `ok` regardless of whether the
 * claim loops are moving makes a hung worker *invisible*. The payload carries
 * each engine's vitals so a stalled one is visible, not just alive. This spec
 * pins that payload as a cross-process **contract** — the consumers (image
 * HEALTHCHECK, compose `service_healthy`, `semiont start` waits, and any
 * operator's `curl :24100/health`) live outside the Worker service, so its
 * own tests of the body it builds can't catch a break in what a running
 * stack serves. The body is checked against the protocol's `WorkerHealth`
 * schema, through the validator generated from it: the spec owns the shape,
 * the worker serves it, and only a running stack shows what it serves.
 *
 * What it pins:
 *
 * 1. **The schema.** Every `/health` body is a `WorkerHealth`. Its objects are
 *    closed, so none of the inference config the vitals are built beside (API
 *    keys, endpoints) can reach the wire.
 * 2. **This knowledge base's entry.** A worker serves several knowledge bases,
 *    one entry each. The entry whose `domain` is the one `browse.kb()` names is
 *    `working`, names the one agent the worker is there
 *    (`did:web:<domain>:agents:<subject>`), lists each engine once, and each
 *    engine's jobs are jobs a claim can name.
 * 3. **The lifecycle.** One real delegated job advances the vitals of the
 *    engine it is done with: `jobsCompleted` increments, `lastClaimAt`/
 *    `lastFinishedAt` populate with claim ≤ finish, and `activeJob` returns to
 *    null. Timestamp comparisons stay *within* the worker's own clock (claim
 *    vs finish, post vs baseline) — never against the test host's clock, so
 *    container clock skew can't flake the test.
 * 4. **Monotonicity.** No engine's `jobsCompleted` ever decreases across
 *    the run — the counters are per-process totals, not windows.
 *
 * Deliberately NOT pinned here: which engine each job has (spec 18 owns
 * that), and the stall watchdog / restart chain (killing a worker mid-job is
 * not a smoke test).
 *
 * Self-seeding: creates its own resource for the delegated job. Slow: the
 * lifecycle leg waits on a real LLM highlight pass (spec-06/11 class).
 */

// The worker publishes its health server on port 24100 of the same host as
// the gateway in every stack shape this suite targets (compose
// `24100:24100`, `semiont start` publishing 24100) — derived from
// E2E_GATEWAY_URL rather than adding a config knob of its own.
const WORKER_HEALTH_URL = (() => {
  const u = new URL(GATEWAY_URL);
  return `${u.protocol}//${u.hostname}:24100/health`;
})();

type EngineHealth = components['schemas']['WorkerEngineHealth'];

/** A job as a claim names it, in words: `mark.<motivation>`, or `yield`. */
const named = (filter: JobFilter): string =>
  filter.jobType === 'mark' ? `mark.${filter.params.motivation}` : filter.jobType;

/** Every job a claim can name: a `mark` job of each motivation, and a `yield` job. */
const JOBS = [...MARK_MOTIVATIONS.map((motivation) => `mark.${motivation}`), 'yield'];

/** An engine, as a key: `<provider> <model>`. */
const engineKey = ({ engine }: EngineHealth): string => `${engine.provider} ${engine.model}`;

/** A vitals timestamp as epoch ms; the schema has already held it to `date-time`. */
const epoch = (at: string | null): number | null => (at === null ? null : Date.parse(at));

async function fetchHealth(): Promise<components['schemas']['WorkerHealth']> {
  const res = await fetch(WORKER_HEALTH_URL);
  expect(res.ok, `GET ${WORKER_HEALTH_URL} → HTTP ${res.status}`).toBe(true);
  const body: unknown = await res.json();
  if (!validators.WorkerHealth(body)) {
    throw new Error(`GET ${WORKER_HEALTH_URL} is not a WorkerHealth: ${formatErrors(validators.WorkerHealth.errors)}`);
  }
  return body;
}

/** The worker's entry for the knowledge base at `domain`, which is working, so it names its agent and engines. */
async function workingEntry(domain: string): Promise<{ did: string; engines: EngineHealth[] }> {
  const { knowledgeBases } = await fetchHealth();
  const entry = knowledgeBases.find((kb) => kb.domain === domain);
  if (entry?.state !== 'working' || entry.did === undefined || entry.engines === undefined) {
    throw new Error(`${WORKER_HEALTH_URL} does not say the worker is working at ${domain}: ${JSON.stringify(entry)}`);
  }
  return { did: entry.did, engines: entry.engines };
}

test.describe('worker vitals (/health)', () => {
  test('payload is the vitals contract and one real delegated job advances the lifecycle', { tag: ['@model'] }, async () => {
    test.setTimeout(120_000);

    const opened = await signInSession();
    const client = opened.session.client;
    try {
      // ── 1–2. The schema, and this knowledge base's entry ──
      const { domain } = await client.browse.kb();
      const baseline = await workingEntry(domain);

      expect(baseline.did, 'the worker is one agent').toMatch(/:agents:[^:]+$/);
      expect(baseline.did.startsWith(`${kbDid(domain)}:agents:`), `${baseline.did} is an agent of ${kbDid(domain)}`).toBe(true);
      expect(new Set(baseline.engines.map(engineKey)).size, 'each engine is listed once').toBe(baseline.engines.length);
      for (const e of baseline.engines) {
        for (const filter of e.jobs) {
          expect(JOBS, `engine ${engineKey(e)}: "${named(filter)}" is a job a claim can name`).toContain(named(filter));
        }
      }

      // ── 3. Baseline for the lifecycle leg ──
      const highlighter = baseline.engines.find((e) => e.jobs.some((filter) => named(filter) === 'mark.highlighting'));
      expect(highlighter, 'some engine is used for highlighting (which one is spec 18)').toBeTruthy();
      const highlighterKey = engineKey(highlighter!);
      const baseCompleted = highlighter!.jobsCompleted;
      const baseFinished = epoch(highlighter!.lastFinishedAt);
      const baseByEngine = new Map(baseline.engines.map((e) => [engineKey(e), e.jobsCompleted]));

      // ── 4. One real delegated job (self-seeded, spec-18 pattern) ──
      const rid = (
        await client.yield.resource({
          name: 'Worker Vitals Lifecycle',
          storageUri: 'file://e2e/worker-vitals-lifecycle.txt',
          file: Buffer.from(
            'Mitochondria generate ATP through oxidative phosphorylation. ' +
              'The electron transport chain pumps protons across the inner membrane. ' +
              'ATP synthase converts the proton gradient into chemical energy.',
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

      // ── 5. The vitals advanced. Poll: job:complete on the bus and the
      // adapter's own bookkeeping are near-simultaneous, not ordered. ──
      await expect
        .poll(
          async () => {
            const e = (await workingEntry(domain)).engines.find((x) => engineKey(x) === highlighterKey);
            return e !== undefined && e.jobsCompleted > baseCompleted && e.activeJob === null;
          },
          {
            timeout: 30_000,
            message: `engine ${highlighterKey}: jobsCompleted must pass ${baseCompleted} and activeJob return to null`,
          },
        )
        .toBe(true);

      const after = await workingEntry(domain);
      const e = after.engines.find((x) => engineKey(x) === highlighterKey)!;

      const claimed = epoch(e.lastClaimAt);
      const finished = epoch(e.lastFinishedAt);
      expect(claimed, 'the job was claimed for the engine (lastClaimAt set)').not.toBeNull();
      expect(finished, 'the job was finished with the engine (lastFinishedAt set)').not.toBeNull();
      expect(finished!, 'claim precedes finish on the worker’s own clock').toBeGreaterThanOrEqual(claimed!);
      if (baseFinished !== null) {
        expect(finished!, 'lastFinishedAt advanced past the pre-job value').toBeGreaterThan(baseFinished);
      }
      expect(e.lastActivityAt, 'activity freshness populated by the pass').not.toBeNull();
      expect(
        e.lastQueuedEventAt,
        'the claim implies the job:queued announcement was seen (SSE push, no polling)',
      ).not.toBeNull();

      // ── 6. Monotonicity across every engine ──
      for (const x of after.engines) {
        const before = baseByEngine.get(engineKey(x));
        if (before !== undefined) {
          expect(
            x.jobsCompleted,
            `engine ${engineKey(x)}: jobsCompleted is monotonic (process-lifetime counter)`,
          ).toBeGreaterThanOrEqual(before);
        }
      }
    } finally {
      opened.dispose();
    }
  });
});
