import { test, expect } from '@playwright/test';
import { MARK_MOTIVATIONS, type JobFilter } from '@semiont/core';
import { GATEWAY_URL } from '../playwright.config';
import { signInSession } from '../fixtures/sdk-session';

/**
 * Smoke test: the worker's `/health` vitals against a live stack. Pure
 * **HTTP + SDK round-trip** (no browser), per the spec-15/18 pattern.
 *
 * Why this exists: a `/health` that serves a static
 * `{status: 'ok', agents: N}` regardless of whether the claim loop is
 * moving makes a hung worker *invisible*. The payload carries per-agent
 * vitals so a stalled worker is visible, not just alive. This
 * spec pins that payload as a cross-process **contract** — the consumers
 * (image HEALTHCHECK, compose `service_healthy`, `semiont start` waits, and any
 * operator's `curl :24100/health`) live outside the jobs package, so unit
 * tests on `buildHealthPayload` can't catch a break in the
 * worker-main shell wiring that serves it. The payload shape is
 * deliberately re-declared here rather than imported from
 * `@semiont/jobs`: importing the producer's type would make the shape
 * check tautological.
 *
 * What it pins:
 *
 * 1. **Freshness gate.** `workers[]` must be present AT ALL. A stack
 *    predating the vitals (semiont-worker < 0.5.13) serves a
 *    static body — an environment verdict ("rebuild the stack"), not
 *    a feature verdict, and the distinctive error below says so.
 * 2. **Payload contract.** `status: 'ok'`, `agents` counts `workers[]`,
 *    and every entry carries identity (`provider`/`model`/`did`/
 *    `serves`: the jobs it serves, each named as a claim names it)
 *    plus vitals (`lastQueuedEventAt`/`lastClaimAt`/`lastFinishedAt`/
 *    `lastActivityAt` as ISO timestamps or honest nulls, `activeJob`,
 *    `jobsCompleted`). No secret material (the vitals are built beside
 *    the resolved inference config, which holds API keys).
 * 3. **The lifecycle.** One real delegated job advances the
 *    serving agent's vitals: `jobsCompleted` increments, `lastClaimAt`/
 *    `lastFinishedAt` populate with claim ≤ finish, and `activeJob`
 *    returns to null. Timestamp comparisons stay *within* the worker's
 *    own clock (claim vs finish, post vs baseline) — never against the
 *    test host's clock, so container clock skew can't flake the test.
 * 4. **Monotonicity.** No agent's `jobsCompleted` ever decreases across
 *    the run — the counters are per-process totals, not windows.
 *
 * Deliberately NOT pinned here: which agent serves which job type
 * (spec 18 owns the routing function), and the stall watchdog / restart
 * chain (killing a worker mid-job is not a smoke test).
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
 * (`WorkerHealthPayload` / `AgentVitals`, packages/jobs/src/worker-runtime.ts,
 * over the SDK's `WorkerVitals`). Every field is runtime-asserted below; the type
 * exists so the assertions read cleanly, not as the check itself.
 */
interface AgentVitalsEntry {
  provider: string;
  model: string;
  did: string;
  serves: JobFilter[];
  lastQueuedEventAt: string | null;
  lastClaimAt: string | null;
  lastFinishedAt: string | null;
  lastActivityAt: string | null;
  activeJob: { jobId: string; type: string; since: string } | null;
  jobsCompleted: number;
}
interface HealthPayload {
  status?: unknown;
  agents?: unknown;
  workers?: AgentVitalsEntry[];
}

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
  test('payload is the vitals contract and one real delegated job advances the lifecycle', async () => {
    test.setTimeout(120_000);

    // ── 1. Freshness gate: the enriched payload must exist on this stack ──
    const baseline = await fetchHealth();
    if (!Array.isArray(baseline.workers)) {
      throw new Error(
        `STACK FRESHNESS GATE: ${WORKER_HEALTH_URL} has no workers[] — the running ` +
          `semiont-worker predates the /health vitals (< 0.5.13) and still serves the ` +
          `static {status, agents} body. Rebuild/redeploy before judging vitals.`,
      );
    }

    // ── 2. Payload contract ──
    expect(baseline.status, 'legacy consumers keep reading status').toBe('ok');
    expect(baseline.agents, 'legacy consumers keep reading agents (= workers.length)').toBe(
      baseline.workers.length,
    );
    expect(baseline.workers.length, 'KB TOML declares ≥1 worker agent').toBeGreaterThan(0);

    for (const w of baseline.workers) {
      const id = `worker ${w.provider}/${w.model}`;
      expect(w.provider, `${id}: structured provider`).toBeTruthy();
      expect(w.model, `${id}: structured model`).toBeTruthy();
      expect(w.did, `${id}: carries its minted DID`).toMatch(/^did:web:.+:agents:[^:]+:[^:]+$/);
      expect(Array.isArray(w.serves) && w.serves.length > 0, `${id}: serves ≥1 job`).toBe(true);
      for (const filter of w.serves) {
        expect(JOBS, `${id}: "${named(filter)}" is a job a claim can name`).toContain(named(filter));
      }

      epochOrNull(w.lastQueuedEventAt, `${id}: lastQueuedEventAt`);
      epochOrNull(w.lastClaimAt, `${id}: lastClaimAt`);
      epochOrNull(w.lastFinishedAt, `${id}: lastFinishedAt`);
      epochOrNull(w.lastActivityAt, `${id}: lastActivityAt`);
      expect(
        typeof w.jobsCompleted === 'number' && w.jobsCompleted >= 0,
        `${id}: jobsCompleted is a non-negative counter`,
      ).toBe(true);
      if (w.activeJob !== null) {
        expect(w.activeJob.jobId, `${id}: activeJob carries jobId`).toBeTruthy();
        expect(w.activeJob.type, `${id}: activeJob carries type`).toBeTruthy();
        epochOrNull(w.activeJob.since, `${id}: activeJob.since`);
      }
    }

    // No secret material: the vitals are assembled beside the resolved
    // inference config (apiKey/endpoint) — none of it may reach the wire.
    expect(
      JSON.stringify(baseline).includes('apiKey'),
      '/health must not leak inference config secrets',
    ).toBe(false);

    // ── 3. Baseline for the lifecycle leg ──
    const owner = baseline.workers.find((w) => w.serves.some((filter) => named(filter) === 'mark.highlighting'));
    expect(owner, 'some agent serves highlighting (routing itself is spec 18)').toBeTruthy();
    const ownerDid = owner!.did;
    const baseCompleted = owner!.jobsCompleted;
    const baseFinished = epochOrNull(owner!.lastFinishedAt, 'baseline lastFinishedAt');
    const baseByDid = new Map(baseline.workers.map((w) => [w.did, w.jobsCompleted]));

    // ── 4. One real delegated job (self-seeded, spec-18 pattern) ──
    const session = await signInSession();
    const client = session.client;
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
      await session.dispose();
    }

    // ── 5. The vitals advanced. Poll: job:complete on the bus and the
    // adapter's own bookkeeping are near-simultaneous, not ordered. ──
    await expect
      .poll(
        async () => {
          const p = await fetchHealth();
          const w = p.workers?.find((x) => x.did === ownerDid);
          return w !== undefined && w.jobsCompleted > baseCompleted && w.activeJob === null;
        },
        {
          timeout: 30_000,
          message: `agent ${ownerDid}: jobsCompleted must pass ${baseCompleted} and activeJob return to null`,
        },
      )
      .toBe(true);

    const after = await fetchHealth();
    const w = after.workers!.find((x) => x.did === ownerDid)!;

    const claimed = epochOrNull(w.lastClaimAt, 'post-job lastClaimAt');
    const finished = epochOrNull(w.lastFinishedAt, 'post-job lastFinishedAt');
    expect(claimed, 'the serving agent claimed the job (lastClaimAt set)').not.toBeNull();
    expect(finished, 'the serving agent finished the job (lastFinishedAt set)').not.toBeNull();
    expect(finished!, 'claim precedes finish on the worker’s own clock').toBeGreaterThanOrEqual(claimed!);
    if (baseFinished !== null) {
      expect(finished!, 'lastFinishedAt advanced past the pre-job value').toBeGreaterThan(baseFinished);
    }
    expect(w.lastActivityAt, 'activity freshness populated by the pass').not.toBeNull();
    expect(
      w.lastQueuedEventAt,
      'the claim implies the job:queued announcement was seen (SSE push, no polling)',
    ).not.toBeNull();

    // ── 6. Monotonicity across the whole pool ──
    for (const x of after.workers!) {
      const before = baseByDid.get(x.did);
      if (before !== undefined) {
        expect(
          x.jobsCompleted,
          `agent ${x.did}: jobsCompleted is monotonic (process-lifetime counter)`,
        ).toBeGreaterThanOrEqual(before);
      }
    }
  });
});
