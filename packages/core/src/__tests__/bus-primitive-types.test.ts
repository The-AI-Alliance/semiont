/**
 * A bus method's types come from the channel name (WORKER-BUS-TYPED-BY-CHANNEL P1).
 *
 * Moved here from `@semiont/sdk` with its subject: the `WorkerBus` interface
 * it guarded was deleted in CLIENT-SUBSCRIPTION-MANIFEST P2 once its one
 * distinguishing member (`addChannels`) went, leaving a bare alias of this
 * primitive. The gate follows the type it gates.
 *
 * `on$<T = Record<string, unknown>>(channel: string)` let every caller name
 * its own payload type, checked against nothing — and the default made
 * "nobody typed this" indistinguishable from "this is typed". One consumer
 * hand-wrote `job:queued`'s payload and lost `userId` for it.
 *
 * **The compiler is the test.** The probes below are never invoked: a
 * `@ts-expect-error` on a real call still *runs* the call under vitest, and
 * these calls are on a `declare`d bus that does not exist at runtime. Each
 * `it` only proves its probe is still linked in, so a deleted probe fails
 * loudly instead of silently passing.
 */

import { describe, it, expect } from 'vitest';
import type { Observable } from 'rxjs';
import type { EventMap, BusRequestPrimitive } from '../index';

/**
 * Equality, not assignability: `Observable<Record<string, unknown>>` satisfies
 * an `extends` check against several channel payloads, so the loose signature
 * this phase replaces could pass a weaker test.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Payloads are INFERRED from the channel argument — no type argument given. */
function inferenceProbe(bus: BusRequestPrimitive) {
  const added = bus.stream('mark:added');
  const exact: Equals<typeof added, Observable<EventMap['mark:added']>> = true;

  // Guards against a signature that types every channel the same way:
  // `Observable<StoredEvent>` would satisfy the assertion above on its own.
  const queued = bus.stream('job:queued');
  const differs: Equals<typeof added, typeof queued> = false;

  return [exact, differs];
}

/** Everything the loose signature used to allow. */
function rejectionProbe(bus: BusRequestPrimitive) {
  // @ts-expect-error — the caller does not choose the payload type
  bus.stream<{ wrong: true }>('mark:added');
  // @ts-expect-error — not a channel the registry declares
  bus.stream('no-such-channel');
  // @ts-expect-error — `isSubscribed` takes registry keys, not strings
  bus.isSubscribed('no-such-channel');
}

describe('BusRequestPrimitive.stream is typed by its channel', () => {
  it('infers the payload from the channel name, and differs per channel', () => {
    expect(typeof inferenceProbe).toBe('function');
  });

  it('carries the spec payload whole — the field a hand-written copy dropped', () => {
    // `job:queued`'s consumer hand-wrote { jobId, jobType, resourceId } and
    // omitted `userId`, the DID the audit trail needs. Derived, it cannot.
    const hasUserId: 'userId' extends keyof EventMap['job:queued'] ? true : false = true;
    expect(hasUserId).toBe(true);
  });
});

describe('BusRequestPrimitive.stream refuses what the old signature allowed', () => {
  it('takes no caller-supplied type, and no channel off the registry', () => {
    expect(typeof rejectionProbe).toBe('function');
  });
});
