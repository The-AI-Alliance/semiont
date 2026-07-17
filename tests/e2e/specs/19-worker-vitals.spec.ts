import { test, expect } from '@playwright/test';
import { SemiontClient } from '@semiont/sdk';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

/**
 * Smoke test — WORKER-LIVENESS.md P1/T0: the worker's `/health` vitals
 * against a live stack. Pure **HTTP + SDK round-trip** (no browser), per
 * the spec-15/18 pattern.
 *
 * Why this exists: the original worker hang (G2) was *invisible* because
 * `/health` served a static `{status: 'ok', agents: N}` regardless of
 * whether the claim loop was moving. P1 enriched the payload with
 * per-agent vitals so a stalled worker is visible, not just alive. This
 * spec pins that payload as a cross-process **contract** — the consumers
 * (image HEALTHCHECK, compose `service_healthy`, start.sh waits, and any
 * operator's `curl :9090/health`) live outside the jobs package, so unit
 * tests on `buildHealthPayload` can't catch a regression in the
 * worker-main shell wiring that serves it. The payload shape is
 * deliberately re-declared here rather than imported from
 * `@semiont/jobs`: importing the producer's type would make the shape
 * check tautological.
 *
 * What it pins:
 *
 * 1. **Freshness gate.** `workers[]` must be present AT ALL. A stack
 *    predating WORKER-LIVENESS P1 (semiont-worker < 0.5.13) serves the
 *    old static body — an environment verdict ("rebuild the stack"), not
 *    a feature verdict, and the distinctive error below says so.
 * 2. **Payload contract.** `status: 'ok'`, `agents` counts `workers[]`,
 *    and every entry carries identity (`provider`/`model`/`did`/
 *    `jobTypes`, concrete job types only — never the literal `'default'`)
 *    plus vitals (`lastQueuedEventAt`/`lastClaimAt`/`lastFinishedAt`/
 *    `lastActivityAt` as ISO timestamps or honest nulls, `activeJob`,
 *    `jobsCompleted`). No secret material (the vitals are built beside
 *    the resolved inference config, which holds API keys).
 * 3. **The lifecycle (T0's short half).** One real assist advances the
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
 * chain (P3/P4 — killing a worker mid-job is not a smoke test).
 *
 * Self-seeding: creates its own resource for the assist pass. Slow: the
 * lifecycle leg waits on a real LLM highlight pass (spec-06/11 class).
 */

// The worker publishes its health server on port 9090 of the same host as
// the backend in every stack shape this suite targets (compose
// `9090:9090`, start.sh `--publish 9090:9090`) — derived from
// E2E_BACKEND_URL rather than adding a config knob of its own.
const WORKER_HEALTH_URL = (() => {
  const u = new URL(BACKEND_URL);
  return `${u.protocol}//${u.hostname}:9090/health`;
})();

/** The six concrete job types (JobType enum, specs/src/components/schemas/JobType.json). */
const JOB_TYPES = [
  'reference-annotation',
  'generation',
  'highlight-annotation',
  'assessment-annotation',
  'comment-annotation',
  'tag-annotation',
] as const;

/**
 * Consumer-side re-declaration of the `/health` contract
 * (`WorkerHealthPayload` / `AgentVitals`, packages/jobs/src/worker-runtime.ts
 * + job-claim-adapter.ts). Every field is runtime-asserted below; the type
 * exists so the assertions read cleanly, not as the check itself.
 */
interface AgentVitalsEntry {
  provider: string;
  model: string;
  did: string;
  jobTypes: string[];
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
  test('payload is the vitals contract and one real assist advances the lifecycle', async () => {
    test.setTimeout(120_000);

    // ── 1. Freshness gate: the enriched payload must exist on this stack ──
    const baseline = await fetchHealth();
    if (!Array.isArray(baseline.workers)) {
      throw new Error(
        `STACK FRESHNESS GATE: ${WORKER_HEALTH_URL} has no workers[] — the running ` +
          `semiont-worker predates WORKER-LIVENESS P1 (< 0.5.13) and still serves the ` +
          `static {status, agents} body. Rebuild/redeploy before judging vitals. ` +
          `(WORKER-LIVENESS.md P1 gate.)`,
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
      expect(Array.isArray(w.jobTypes) && w.jobTypes.length > 0, `${id}: serves ≥1 job type`).toBe(true);
      for (const jt of w.jobTypes) {
        expect(jt, `${id}: 'default' expands at resolution — never a served capability`).not.toBe('default');
        expect(JOB_TYPES as readonly string[], `${id}: "${jt}" is a concrete JobType`).toContain(jt);
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
    const owner = baseline.workers.find((w) => w.jobTypes.includes('highlight-annotation'));
    expect(owner, 'some agent serves highlight-annotation (routing itself is spec 18)').toBeTruthy();
    const ownerDid = owner!.did;
    const baseCompleted = owner!.jobsCompleted;
    const baseFinished = epochOrNull(owner!.lastFinishedAt, 'baseline lastFinishedAt');
    const baseByDid = new Map(baseline.workers.map((w) => [w.did, w.jobsCompleted]));

    // ── 4. One real assist (self-seeded, spec-18 pattern) ──
    const client = await SemiontClient.signInHttp({
      baseUrl: BACKEND_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });
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

      const finalEvent = await client.mark.assist(rid, 'highlighting', { language: 'en' });
      expect(
        finalEvent.kind,
        'highlight assist completes (highlight-annotation job → job:complete)',
      ).toBe('complete');
    } finally {
      client.dispose();
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

    const claimed = epochOrNull(w.lastClaimAt, 'post-assist lastClaimAt');
    const finished = epochOrNull(w.lastFinishedAt, 'post-assist lastFinishedAt');
    expect(claimed, 'the serving agent claimed the job (lastClaimAt set)').not.toBeNull();
    expect(finished, 'the serving agent finished the job (lastFinishedAt set)').not.toBeNull();
    expect(finished!, 'claim precedes finish on the worker’s own clock').toBeGreaterThanOrEqual(claimed!);
    if (baseFinished !== null) {
      expect(finished!, 'lastFinishedAt advanced past the pre-assist value').toBeGreaterThan(baseFinished);
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
