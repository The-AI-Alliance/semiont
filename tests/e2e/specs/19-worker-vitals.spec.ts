import { test, expect } from '@playwright/test';
import { MARK_MOTIVATIONS, type JobFilter } from '@semiont/core';
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
 * stack serves. The payload shape is deliberately re-declared here: it is
 * the consumer's reading of docs/protocol/WORKER-SERVICE.md H1, and a shape
 * taken from the producer would make the check tautological.
 *
 * What it pins:
 *
 * 1. **Freshness gate.** `engines[]` must be present AT ALL. A stack whose
 *    worker predates it serves another body — an environment verdict
 *    ("rebuild the stack"), not a feature verdict, and the error below says so.
 * 2. **Payload contract.** `status: 'ok'`; `did`, the one agent the worker
 *    is (`…:agents:<subject>`); and every engine entry carries which it is
 *    (`provider`/`model`, and `jobs`: the jobs the worker does with it, each
 *    named as a claim names it) plus vitals (`lastQueuedEventAt`/
 *    `lastClaimAt`/`lastFinishedAt`/`lastActivityAt` as ISO timestamps or
 *    honest nulls, `activeJob`, `jobsCompleted`). No secret material (the
 *    vitals are built beside the resolved inference config, which holds API
 *    keys).
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

/** A job as a claim names it, in words: `mark.<motivation>`, or `yield`. */
const named = (filter: JobFilter): string =>
  filter.jobType === 'mark' ? `mark.${filter.params.motivation}` : filter.jobType;

/** Every job a claim can name: a `mark` job of each motivation, and a `yield` job. */
const JOBS = [...MARK_MOTIVATIONS.map((motivation) => `mark.${motivation}`), 'yield'];

/**
 * Consumer-side re-declaration of the `/health` contract
 * (docs/protocol/WORKER-SERVICE.md H1, over what a worker can say of itself,
 * WORKER-CONTRACT V1). Every field is runtime-asserted below; the type
 * exists so the assertions read cleanly, not as the check itself.
 */
interface EngineVitals {
  provider: string;
  model: string;
  jobs: JobFilter[];
  lastQueuedEventAt: string | null;
  lastClaimAt: string | null;
  lastFinishedAt: string | null;
  lastActivityAt: string | null;
  activeJob: { jobId: string; type: string; since: string } | null;
  jobsCompleted: number;
}
interface HealthPayload {
  status?: unknown;
  did?: unknown;
  engines?: EngineVitals[];
}

/** An engine, as a key: `<provider> <model>`. */
const engineKey = (engine: EngineVitals): string => `${engine.provider} ${engine.model}`;

async function fetchHealth(): Promise<HealthPayload> {
  const res = await fetch(WORKER_HEALTH_URL);
  expect(res.ok, `GET ${WORKER_HEALTH_URL} → HTTP ${res.status}`).toBe(true);
  return (await res.json()) as HealthPayload;
}

/** Assert a vitals timestamp is null or a parseable ISO instant; return its epoch ms (or null). */
function epochOrNull(value: string | null, label: string): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  expect(Number.isNaN(ms), `${label} is a parseable timestamp — got "${value}"`).toBe(false);
  return ms;
}

test.describe('worker vitals (/health)', () => {
  test('payload is the vitals contract and one real delegated job advances the lifecycle', { tag: ['@model'] }, async () => {
    test.setTimeout(120_000);

    // ── 1. Freshness gate: the payload must exist on this stack ──
    const baseline = await fetchHealth();
    if (!Array.isArray(baseline.engines)) {
      throw new Error(
        `STACK FRESHNESS GATE: ${WORKER_HEALTH_URL} has no engines[] — the running ` +
          `semiont-worker predates it. Rebuild/redeploy before judging vitals.`,
      );
    }

    // ── 2. Payload contract ──
    expect(baseline.status, 'status').toBe('ok');
    expect(baseline.did, 'the worker is one agent').toMatch(/^did:web:.+:agents:[^:]+$/);
    expect(baseline.engines.length, 'the Inference document gives ≥1 job an engine').toBeGreaterThan(0);
    expect(new Set(baseline.engines.map(engineKey)).size, 'each engine is listed once').toBe(baseline.engines.length);

    for (const e of baseline.engines) {
      const id = `engine ${engineKey(e)}`;
      expect(e.provider, `${id}: structured provider`).toBeTruthy();
      expect(e.model, `${id}: structured model`).toBeTruthy();
      expect(Array.isArray(e.jobs) && e.jobs.length > 0, `${id}: is used for ≥1 job`).toBe(true);
      for (const filter of e.jobs) {
        expect(JOBS, `${id}: "${named(filter)}" is a job a claim can name`).toContain(named(filter));
      }

      epochOrNull(e.lastQueuedEventAt, `${id}: lastQueuedEventAt`);
      epochOrNull(e.lastClaimAt, `${id}: lastClaimAt`);
      epochOrNull(e.lastFinishedAt, `${id}: lastFinishedAt`);
      epochOrNull(e.lastActivityAt, `${id}: lastActivityAt`);
      expect(
        typeof e.jobsCompleted === 'number' && e.jobsCompleted >= 0,
        `${id}: jobsCompleted is a non-negative counter`,
      ).toBe(true);
      if (e.activeJob !== null) {
        expect(e.activeJob.jobId, `${id}: activeJob carries jobId`).toBeTruthy();
        expect(e.activeJob.type, `${id}: activeJob carries type`).toBeTruthy();
        epochOrNull(e.activeJob.since, `${id}: activeJob.since`);
      }
    }

    // No secret material: the vitals are assembled beside the resolved
    // inference config (apiKey/endpoint) — none of it may reach the wire.
    expect(
      JSON.stringify(baseline).includes('apiKey'),
      '/health must not leak inference config secrets',
    ).toBe(false);

    // ── 3. Baseline for the lifecycle leg ──
    const highlighter = baseline.engines.find((e) => e.jobs.some((filter) => named(filter) === 'mark.highlighting'));
    expect(highlighter, 'some engine is used for highlighting (which one is spec 18)').toBeTruthy();
    const highlighterKey = engineKey(highlighter!);
    const baseCompleted = highlighter!.jobsCompleted;
    const baseFinished = epochOrNull(highlighter!.lastFinishedAt, 'baseline lastFinishedAt');
    const baseByEngine = new Map(baseline.engines.map((e) => [engineKey(e), e.jobsCompleted]));

    // ── 4. One real delegated job (self-seeded, spec-18 pattern) ──
    const opened = await signInSession();
    const client = opened.session.client;
    try {
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
    } finally {
      opened.dispose();
    }

    // ── 5. The vitals advanced. Poll: job:complete on the bus and the
    // adapter's own bookkeeping are near-simultaneous, not ordered. ──
    await expect
      .poll(
        async () => {
          const p = await fetchHealth();
          const e = p.engines?.find((x) => engineKey(x) === highlighterKey);
          return e !== undefined && e.jobsCompleted > baseCompleted && e.activeJob === null;
        },
        {
          timeout: 30_000,
          message: `engine ${highlighterKey}: jobsCompleted must pass ${baseCompleted} and activeJob return to null`,
        },
      )
      .toBe(true);

    const after = await fetchHealth();
    const e = after.engines!.find((x) => engineKey(x) === highlighterKey)!;

    const claimed = epochOrNull(e.lastClaimAt, 'post-job lastClaimAt');
    const finished = epochOrNull(e.lastFinishedAt, 'post-job lastFinishedAt');
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
    for (const x of after.engines!) {
      const before = baseByEngine.get(engineKey(x));
      if (before !== undefined) {
        expect(
          x.jobsCompleted,
          `engine ${engineKey(x)}: jobsCompleted is monotonic (process-lifetime counter)`,
        ).toBeGreaterThanOrEqual(before);
      }
    }
  });
});
