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
import type { Observable } from 'rxjs';
import { FaultyTransport, type FaultAction } from './faulty-transport';
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
    /** Passed through to FaultyTransport (reply synthesis). */
    makeResponse?: (operation: string, payload: Record<string, unknown>) => unknown;
    /** fast-check run budget (default 25 — CI-fast; crank locally). */
    numRuns?: number;
    /** Real-scheduler jitter headroom on the bound (default 4×). */
    slackFactor?: number;
}
/** The five wire behaviors, uniformly weighted; delays stay small (≤5 ms). */
export declare function arbFaultAction(): fc.Arbitrary<FaultAction>;
export declare function arbFaultSchedule(maxLength?: number): fc.Arbitrary<readonly FaultAction[]>;
/**
 * Run L1 + L2 against `spec` across generated fault schedules. Throws a
 * labeled Error (`L1: …` / `L2: …`) on the first violation.
 */
export declare function assertLivenessAxioms(spec: LivenessAxiomSpec): Promise<void>;
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
export declare function arbDeliveryOps(maxOps?: number): fc.Arbitrary<readonly DeliveryOp[]>;
/**
 * Run L3 against `spec` across generated write/transition interleavings.
 * Throws a labeled Error (`L3: …`) on the first violation: an event written
 * to a live connection delivered zero times (lost — retired by abort instead
 * of drain) or more than once (duplicate).
 */
export declare function assertExactlyOnceDelivery(spec: DeliveryAxiomSpec): Promise<void>;
