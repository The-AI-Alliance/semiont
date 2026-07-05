/**
 * Executable enforcement of the liveness axioms — the runtime twin of
 * `.plans/LIVENESS-AXIOMS.md`, and the composition-level sibling of
 * `assertStateUnitAxioms` (state-unit-axioms.ts). Where the StateUnit axioms
 * make *per-unit* wrongness mechanically detectable, these make *silence*
 * detectable: every existing enforcement tier is safety (nothing wrong is
 * delivered); these assert liveness (something is eventually delivered).
 *
 * Axioms (fault-schedule dimension; fast-check):
 *   L1  Subscriber liveness — every output emits next|error within the bound,
 *       under any fault schedule. Error is a permitted outcome; the forbidden
 *       fourth state is pending-forever.
 *   L2  Request settlement — every awaited path settles within the bound;
 *       re-issues per logical request stay within the retry budget (B14: one);
 *       a faulted request must be re-issued or surfaced, never swallowed.
 *   L3  Delivery across lifecycle transitions — every event written to a live
 *       connection reaches the output exactly once, wherever a client-initiated
 *       transition (handover / reconnect / scope change) lands. Retirement is
 *       by drain, never by abort (TRANSPORT-HTTP.md, Abort discipline).
 *
 * Framework-agnostic on purpose — only `rxjs` + `fast-check`, no `vitest` — so
 * it ships through `@semiont/core/testing` and any package's test runner can
 * invoke it. Deterministic virtual time: properties pass a small explicit
 * `timeoutMs` to `busRequest`; no `Date.now`, no 30 s real waits.
 */

import * as fc from 'fast-check';
import type { Observable, Subscription } from 'rxjs';
import { FaultyTransport, type FaultAction, type ScopeModel } from './faulty-transport';

// ── L1/L2: liveness over a composition on FaultyTransport ────────────────

/** What one fresh run of the composition exposes to the axioms. */
export interface LivenessScenario {
  /**
   * Live-query-shaped outputs. The harness subscribes each one; every
   * subscription must see `next` or `error` within the bound (L1).
   */
  outputs: readonly Observable<unknown>[];
  /**
   * Awaited paths. Each promise must settle — resolve or reject — within the
   * bound (L2). Rejections are fine; pending-forever is the violation.
   */
  settlements?: readonly Promise<unknown>[];
  teardown?: () => void;
}

export interface LivenessAxiomSpec {
  /** Build a FRESH composition wired to the given transport. Called per run. */
  setup: (transport: FaultyTransport) => LivenessScenario | Promise<LivenessScenario>;
  /**
   * The timeoutMs the scenario passes to `busRequest` — the bound is derived
   * from it: (timeoutMs × (1 + retryBudget) + Σdelays) × slackFactor.
   */
  timeoutMs: number;
  /** Max sanctioned re-issues per logical request (B14 budget). Default 1. */
  retryBudget?: number;
  /** Override the generated fault schedules (teeth tests pin one). */
  scheduleArb?: fc.Arbitrary<readonly FaultAction[]>;
  /** Scope model(s) to run under. Default `'single-slot-throw'`. */
  scopeModel?: ScopeModel | 'both';
  /** Passed through to FaultyTransport (reply synthesis). */
  makeResponse?: (operation: string, payload: Record<string, unknown>) => unknown;
  /** fast-check run budget (default 25 — CI-fast; crank locally). */
  numRuns?: number;
  /** Real-scheduler jitter headroom on the bound (default 4×). */
  slackFactor?: number;
}

/** The five wire behaviors, uniformly weighted; delays stay small (≤5 ms). */
export function arbFaultAction(): fc.Arbitrary<FaultAction> {
  return fc.oneof(
    fc.constant<FaultAction>({ kind: 'deliver' }),
    fc.constant<FaultAction>({ kind: 'drop-reply' }),
    fc.integer({ min: 0, max: 5 }).map((ms): FaultAction => ({ kind: 'delay', ms })),
    fc.constant<FaultAction>({ kind: 'duplicate-reply' }),
    fc.constant<FaultAction>({ kind: 'reject-emit' }),
  );
}

export function arbFaultSchedule(maxLength = 8): fc.Arbitrary<readonly FaultAction[]> {
  return fc.array(arbFaultAction(), { minLength: 1, maxLength });
}

function describeSchedule(schedule: readonly FaultAction[]): string {
  return schedule.map((a) => (a.kind === 'delay' ? `delay(${a.ms})` : a.kind)).join(',');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sibling of state-unit-axioms' `run`, adapted for properties that check more
 * than one axiom: fast-check's falsification message carries the seed and
 * counterexample but not the thrown axiom id (fc v4 moves the inner error to
 * `cause`), so the property captures its own labeled violation into `slot`
 * and the wrapper re-throws with the axiom id leading and fc's detail after.
 */
async function runLabeled(
  fallback: string,
  slot: { violation: Error | null },
  assertion: () => Promise<void>,
): Promise<void> {
  try {
    await assertion();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (slot.violation) throw new Error(`${slot.violation.message}\n${detail}`);
    throw new Error(`${fallback}: ${detail}`);
  }
}

/** Wrap a check block so its labeled throw lands in `slot` before falsifying. */
function capturing(slot: { violation: Error | null }, block: () => void): void {
  try {
    block();
  } catch (e) {
    slot.violation = e instanceof Error ? e : new Error(String(e));
    throw e;
  }
}

/**
 * Run L1 + L2 against `spec` across generated fault schedules. Throws a
 * labeled Error (`L1: …` / `L2: …`) on the first violation.
 */
export async function assertLivenessAxioms(spec: LivenessAxiomSpec): Promise<void> {
  const retryBudget = spec.retryBudget ?? 1;
  const slack = spec.slackFactor ?? 4;
  const scheduleArb = spec.scheduleArb ?? arbFaultSchedule();
  const scopeArb: fc.Arbitrary<ScopeModel> =
    spec.scopeModel === 'both'
      ? fc.constantFrom<ScopeModel>('single-slot-throw', 'multi')
      : fc.constant(spec.scopeModel ?? 'single-slot-throw');

  const slot = { violation: null as Error | null };
  await runLabeled('liveness', slot, () =>
    fc.assert(
      fc.asyncProperty(scheduleArb, scopeArb, async (schedule, scopeModel) => {
        const delayTotal = schedule.reduce((n, a) => n + (a.kind === 'delay' ? a.ms : 0), 0);
        const bound = (spec.timeoutMs * (1 + retryBudget) + delayTotal) * slack;
        const transport = new FaultyTransport({
          schedule,
          scopeModel,
          ...(spec.makeResponse ? { makeResponse: spec.makeResponse } : {}),
        });
        const scenario = await spec.setup(transport);
        const outputs = scenario.outputs;
        const settlements = scenario.settlements ?? [];

        // Subscribe every output (that's what makes a live query live) and
        // track notifications; track settlement of every awaited path.
        const notified: boolean[] = outputs.map(() => false);
        const settled: boolean[] = settlements.map(() => false);
        let doneResolve: () => void = () => {};
        const allDone = new Promise<void>((resolve) => { doneResolve = resolve; });
        const check = (): void => {
          if (notified.every(Boolean) && settled.every(Boolean)) doneResolve();
        };
        const subs: Subscription[] = outputs.map((o, i) =>
          o.subscribe({
            next: () => { notified[i] = true; check(); },
            error: () => { notified[i] = true; check(); },
          }),
        );
        settlements.forEach((p, i) => {
          p.then(() => { settled[i] = true; check(); },
                 () => { settled[i] = true; check(); });
        });
        check();

        // Wait for full liveness or the bound, whichever first.
        await Promise.race([allDone, sleep(bound)]);

        try {
          // L2 first: when it applies it names the mechanism (swallow, budget,
          // unsettled await); L1 below is the broader every-output net. All-
          // outputs-silent is a subset of any-output-silent, so checking L1
          // first would shadow the sharper L2 diagnoses entirely.
          capturing(slot, () => {
            // L2 — settlement: every awaited path settled.
            settled.forEach((seen, i) => {
              if (!seen) {
                throw new Error(
                  `L2: settlement #${i} did not settle within ${bound}ms ` +
                  `under schedule ⟨${describeSchedule(schedule)}⟩ — the forbidden fourth state`,
                );
              }
            });

            // L2 — retry accounting over the transport's request log.
            const issues = new Map<string, { count: number; lastFaulted: boolean }>();
            for (const entry of transport.requestLog) {
              const prior = issues.get(entry.retryKey) ?? { count: 0, lastFaulted: false };
              issues.set(entry.retryKey, {
                count: prior.count + 1,
                lastFaulted: entry.action.kind === 'drop-reply' || entry.action.kind === 'reject-emit',
              });
            }
            for (const [key, { count, lastFaulted }] of issues) {
              if (count > 1 + retryBudget) {
                throw new Error(
                  `L2: request ⟨${key}⟩ issued ${count} times — exceeds the retry budget ` +
                  `(1 + ${retryBudget}) under schedule ⟨${describeSchedule(schedule)}⟩`,
                );
              }
              // Swallow detection: the final issue of a logical request was
              // faulted, the composition had retry budget left but didn't use
              // it, and no output surfaced anything — the rejection went into
              // a void (the pre-B14 `catch(() => {})`).
              if (lastFaulted && count <= retryBudget && outputs.length > 0 && !notified.some(Boolean)) {
                throw new Error(
                  `L2: faulted request ⟨${key}⟩ was neither re-issued nor surfaced ` +
                  `under schedule ⟨${describeSchedule(schedule)}⟩ — rejection swallowed`,
                );
              }
            }

            // L1 — every subscription saw next|error; pending-forever is the bug.
            notified.forEach((seen, i) => {
              if (!seen) {
                throw new Error(
                  `L1: output #${i} received no next/error within ${bound}ms ` +
                  `under schedule ⟨${describeSchedule(schedule)}⟩ (scope=${scopeModel}) — silently pending`,
                );
              }
            });
          });
        } finally {
          subs.forEach((s) => s.unsubscribe());
          scenario.teardown?.();
          transport.dispose();
        }
      }),
      { numRuns: spec.numRuns ?? 25 },
    ),
  );
}

// ── L3: exactly-once delivery across client-initiated transitions ────────

/**
 * A connection-stream-shaped subject: something that accepts writes to the
 * live connection, can be told to transition (handover / reconnect / scope
 * change), and exposes the subscriber-facing output. P3 adapts the real
 * actor's mock-connection harness to this shape; the teeth tests drive
 * reconstructed pre-fix doubles.
 */
export interface DeliverySubject {
  /** Write the event with this id to the currently-live connection. */
  write: (eventId: string) => void;
  /** Client-initiated lifecycle transition. */
  transition: () => void | Promise<void>;
  /** Subscriber-facing output; each emission is a delivered event id. */
  output$: Observable<string>;
  /**
   * Drain pending asynchronous delivery at end of sequence (a live connection
   * eventually flushes). Default: one macrotask tick.
   */
  settle?: () => Promise<void>;
  teardown?: () => void;
}

export type DeliveryOp = 'write' | 'transition';

export interface DeliveryAxiomSpec {
  /** Build a FRESH subject. Called per run. */
  setup: () => DeliverySubject;
  /** Override the generated op sequences (teeth tests pin one). */
  opsArb?: fc.Arbitrary<readonly DeliveryOp[]>;
  /** Max generated sequence length (default 12). */
  maxOps?: number;
  /** fast-check run budget (default 50 — these runs are cheap). */
  numRuns?: number;
}

export function arbDeliveryOps(maxOps = 12): fc.Arbitrary<readonly DeliveryOp[]> {
  return fc
    .array(fc.constantFrom<DeliveryOp>('write', 'transition'), { minLength: 1, maxLength: maxOps })
    // A sequence with no write asserts nothing — always exercise delivery.
    .map((ops) => (ops.includes('write') ? ops : ([...ops, 'write'] as const)));
}

/**
 * Run L3 against `spec` across generated write/transition interleavings.
 * Throws a labeled Error (`L3: …`) on the first violation: an event written
 * to a live connection delivered zero times (lost — retired by abort instead
 * of drain) or more than once (duplicate).
 */
export async function assertExactlyOnceDelivery(spec: DeliveryAxiomSpec): Promise<void> {
  const opsArb = spec.opsArb ?? arbDeliveryOps(spec.maxOps ?? 12);

  const slot = { violation: null as Error | null };
  await runLabeled('L3', slot, () =>
    fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const subject = spec.setup();
        const delivered: string[] = [];
        const sub = subject.output$.subscribe((id) => delivered.push(id));
        const written: string[] = [];
        try {
          for (let i = 0; i < ops.length; i++) {
            if (ops[i] === 'write') {
              const id = `e${i}`;
              written.push(id);
              subject.write(id);
            } else {
              await subject.transition();
            }
            // Deliberately no settling between ops: the interesting races are
            // transitions landing before a write's asynchronous delivery.
          }
          await (subject.settle?.() ?? sleep(0));

          capturing(slot, () => {
            for (const id of written) {
              const n = delivered.filter((d) => d === id).length;
              if (n === 0) {
                throw new Error(
                  `L3: event ⟨${id}⟩ delivered 0 times under ⟨${ops.join(',')}⟩ — ` +
                  `lost across a transition (retire by drain, never by abort)`,
                );
              }
              if (n > 1) {
                throw new Error(
                  `L3: event ⟨${id}⟩ delivered ${n} times under ⟨${ops.join(',')}⟩ — duplicate delivery`,
                );
              }
            }
          });
        } finally {
          sub.unsubscribe();
          subject.teardown?.();
        }
      }),
      { numRuns: spec.numRuns ?? 50 },
    ),
  );
}
