/**
 * Unit tests for `busRequest` and `BusRequestError`.
 *
 * Covers the three result paths the helper produces:
 *   - success: result event with matching `correlationId` resolves with `response`
 *   - rejection: failure event resolves into a `BusRequestError` with code
 *     `bus.rejected` and structured `details`
 *   - timeout: an rxjs `TimeoutError` from the operator is wrapped in a
 *     `BusRequestError` with code `bus.timeout` and structured `details`
 *
 * Plus correlation hygiene: the helper writes a fresh `correlationId` into
 * the emitted payload, ignores result/failure events on the same channels
 * whose `correlationId` doesn't match, and resolves on the first matching
 * one.
 */

import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { SemiontError } from '../errors';
import type { EventMap } from '../bus-protocol';
import type { ConnectionState } from '../transport';

import {
  busRequest,
  BusRequestError,
  type BusRequestPrimitive,
} from '../bus-request';

interface MockBus extends BusRequestPrimitive {
  emitChannel: string | null;
  emitPayload: Record<string, unknown> | null;
  resultSubject: Subject<unknown>;
  failureSubject: Subject<unknown>;
  stateSubject: BehaviorSubject<ConnectionState>;
}

// `initialState` defaults to 'open' so the pre-gate tests above keep their
// exact emit timing: an already-deliverable state takes the synchronous fast
// path (BUS-ATTACH-GATE.md D4) and the gate is invisible.
function makeBus(
  resultChannel: string,
  failureChannel: string,
  initialState: ConnectionState = 'open',
): MockBus {
  const resultSubject = new Subject<unknown>();
  const failureSubject = new Subject<unknown>();
  const stateSubject = new BehaviorSubject<ConnectionState>(initialState);
  const bus: MockBus = {
    emitChannel: null,
    emitPayload: null,
    resultSubject,
    failureSubject,
    stateSubject,
    state$: stateSubject.asObservable(),
    emit: vi.fn(async (channel: keyof EventMap, payload: EventMap[keyof EventMap]) => {
      bus.emitChannel = channel as string;
      bus.emitPayload = payload as Record<string, unknown>;
    }) as BusRequestPrimitive['emit'],
    stream: vi.fn((channel: keyof EventMap) => {
      if ((channel as string) === resultChannel) {
        return resultSubject.asObservable() as unknown as Observable<EventMap[keyof EventMap]>;
      }
      if ((channel as string) === failureChannel) {
        return failureSubject.asObservable() as unknown as Observable<EventMap[keyof EventMap]>;
      }
      return new Subject<unknown>().asObservable() as unknown as Observable<EventMap[keyof EventMap]>;
    }) as BusRequestPrimitive['stream'],
  };
  return bus;
}

describe('busRequest', () => {
  // A real registered operation: `busRequest` now takes the operation key (the
  // request channel) and looks up result/failure from `BUS_OPERATIONS`. The mock
  // bus is keyed on the derived channel names, so the fixtures keep them as
  // constants for the stream wiring.
  const EMIT = 'gather:resource-requested';
  const RESULT = 'gather:resource-complete';
  const FAILURE = 'gather:resource-failed';

  it('emits the request with a generated correlationId and resolves on the matching result', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest(bus, EMIT, { foo: 'bar' });

    // Let the synchronous emit run.
    await Promise.resolve();
    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(bus.emitChannel).toBe(EMIT);
    expect(bus.emitPayload).toMatchObject({ foo: 'bar' });
    const cid = bus.emitPayload!.correlationId as string;
    expect(typeof cid).toBe('string');
    expect(cid.length).toBeGreaterThan(0);

    bus.resultSubject.next({ correlationId: cid, response: { value: 42 } });
    expect(await promise).toEqual({ value: 42 });
  });

  it('ignores result events with a non-matching correlationId', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest(bus, EMIT, {});
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    // Wrong correlationId: must be ignored.
    bus.resultSubject.next({ correlationId: 'somebody-else', response: { value: 1 } });
    bus.resultSubject.next({ correlationId: cid, response: { value: 2 } });

    expect(await promise).toEqual({ value: 2 });
  });

  it('rejects with BusRequestError(bus.rejected) when a failure event arrives', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const captured = busRequest(bus, EMIT, {}).catch((e) => e);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.failureSubject.next({ correlationId: cid, message: 'permission denied' });

    const err = await captured;
    expect(err).toBeInstanceOf(BusRequestError);
    expect(err).toMatchObject({
      code: 'bus.rejected',
      message: 'permission denied',
      name: 'BusRequestError',
    });
  });

  it('attaches structured details on bus.rejected', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const captured = busRequest(bus, EMIT, {}).catch((e) => e);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    const failurePayload = { correlationId: cid, message: 'denied', extra: 'context' };
    bus.failureSubject.next(failurePayload);

    const e = (await captured) as BusRequestError;
    expect(e).toBeInstanceOf(BusRequestError);
    expect(e.details).toMatchObject({
      channel: FAILURE,
      correlationId: cid,
      payload: failurePayload,
    });
  });

  it('falls back to a default message when the failure event has no `message`', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const captured = busRequest(bus, EMIT, {}).catch((e) => e);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.failureSubject.next({ correlationId: cid });

    const err = await captured;
    expect(err).toMatchObject({
      code: 'bus.rejected',
      message: 'Bus request rejected',
    });
  });

  it('rejects with BusRequestError(bus.timeout) when no event arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const bus = makeBus(RESULT, FAILURE);
      // Attach the catch handler synchronously so the rejection is never
      // unhandled — chained `await expect(...).rejects` triggers an
      // unhandled-rejection window that vitest reports as a failure.
      const captured = busRequest(bus, EMIT, {}, 100).catch((e) => e);

      await vi.advanceTimersByTimeAsync(101);

      const err = await captured;
      expect(err).toBeInstanceOf(BusRequestError);
      expect(err).toMatchObject({
        code: 'bus.timeout',
        name: 'BusRequestError',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches structured details on bus.timeout', async () => {
    vi.useFakeTimers();
    try {
      const bus = makeBus(RESULT, FAILURE);
      const captured = busRequest(bus, EMIT, {}, 50).catch((e) => e);
      await Promise.resolve();
      const cid = bus.emitPayload!.correlationId as string;

      await vi.advanceTimersByTimeAsync(51);

      const e = (await captured) as BusRequestError;
      expect(e).toBeInstanceOf(BusRequestError);
      expect(e.code).toBe('bus.timeout');
      expect(e.message).toContain('50ms');
      expect(e.message).toContain(RESULT);
      expect(e.details).toEqual({
        channel: EMIT,
        resultChannel: RESULT,
        correlationId: cid,
        timeoutMs: 50,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the first matching result and ignores any after', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest(bus, EMIT, {});
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.resultSubject.next({ correlationId: cid, response: { value: 1 } });
    bus.resultSubject.next({ correlationId: cid, response: { value: 2 } });

    expect(await promise).toEqual({ value: 1 });
  });

  it("re-throws emit's rejection without leaving the result subscription as an unhandled rejection", async () => {
    // Regression: busRequest's `firstValueFrom(result$)` subscribes
    // BEFORE awaiting `bus.emit()`. If emit throws, control leaves
    // busRequest without ever awaiting the result promise. Its
    // subscription stays open until the underlying stream completes
    // (in production: during `semiont.dispose()`), at which point
    // firstValueFrom throws EmptyError with no consumer — surfacing
    // as an uncaught rejection that bubbled out of the SDK into
    // skill scripts as a cosmetic stack trace after `Done.`.
    //
    // Pin the behavior: emit rejects → busRequest rethrows; the
    // resultSubject is then completed (mimicking bus disposal); no
    // unhandled rejection escapes.

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const bus = makeBus(RESULT, FAILURE);
      bus.emit = vi.fn(async () => { throw new Error('emit failed'); }) as BusRequestPrimitive['emit'];

      await expect(
        busRequest(bus, EMIT, {}),
      ).rejects.toThrow('emit failed');

      // Now complete the result stream, as `semiont.dispose()` would —
      // this is what previously fired the dangling EmptyError.
      bus.resultSubject.complete();
      bus.failureSubject.complete();

      // Let any pending microtasks settle.
      await new Promise((r) => setTimeout(r, 10));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not leak an unhandled rejection when the bus is disposed while a fire-and-forget request is in flight', async () => {
    // The reported crash (busrequest-emptyerror-on-dispose): a busRequest whose
    // `emit` is still pending — so its internal `firstValueFrom` promise has no
    // awaiter yet — and whose returned promise nobody awaits. When the bus
    // completes (dispose), pre-fix `firstValueFrom` rejects `EmptyError` with no
    // handler → unhandledRejection → process crash.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const bus = makeBus(RESULT, FAILURE);
      // emit never resolves → busRequest parks at `await bus.emit()`, so its
      // `await resultPromise` is never reached (resultPromise has no awaiter).
      bus.emit = vi.fn(() => new Promise<void>(() => {})) as BusRequestPrimitive['emit'];

      // Fire-and-forget: do NOT await the returned promise.
      void busRequest(bus, EMIT, {});
      await Promise.resolve();

      // Dispose: complete the underlying subjects, as `semiont.dispose()` does.
      bus.resultSubject.complete();
      bus.failureSubject.complete();

      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects an awaited request with BusRequestError(bus.closed) when the bus is disposed before a reply', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest(bus, EMIT, {});
    await Promise.resolve(); // let emit resolve; busRequest now awaits the reply

    // Dispose before any reply arrives.
    bus.resultSubject.complete();
    bus.failureSubject.complete();

    await expect(promise).rejects.toMatchObject({ code: 'bus.closed' });
  });
});

describe('busRequest attach gate (.plans/BUS-ATTACH-GATE.md)', () => {
  // No correlated emit before the reply path exists: busRequest waits — inside
  // its existing timeout budget (D4) — for `state$` to report the one
  // deliverable state, `'open'` (D3 as amended 2026-07-29: `degraded` is a
  // dropped stream by definition and waits like the rest).
  const EMIT = 'gather:resource-requested';
  const RESULT = 'gather:resource-complete';
  const FAILURE = 'gather:resource-failed';

  it('does not emit while connecting; flip to open → exactly one emit, and the reply resolves', async () => {
    const bus = makeBus(RESULT, FAILURE, 'connecting');
    const promise = busRequest(bus, EMIT, { foo: 'bar' });

    // Give a premature emit every chance to surface.
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.emit).not.toHaveBeenCalled();

    bus.stateSubject.next('open');
    await vi.waitFor(() => expect(bus.emit).toHaveBeenCalledTimes(1));

    const cid = bus.emitPayload!.correlationId as string;
    bus.resultSubject.next({ correlationId: cid, response: { value: 7 } });
    expect(await promise).toEqual({ value: 7 });
  });

  it('degraded waits (D3 as amended) — recovery via connecting → open releases the gate', async () => {
    const bus = makeBus(RESULT, FAILURE, 'degraded');
    const promise = busRequest(bus, EMIT, {});

    await new Promise((r) => setTimeout(r, 10));
    expect(bus.emit).not.toHaveBeenCalled();

    // The legitimate recovery edge (actor transition table): degraded →
    // connecting → open. Only the final hop opens the gate.
    bus.stateSubject.next('connecting');
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.emit).not.toHaveBeenCalled();

    bus.stateSubject.next('open');
    await vi.waitFor(() => expect(bus.emit).toHaveBeenCalledTimes(1));

    const cid = bus.emitPayload!.correlationId as string;
    bus.resultSubject.next({ correlationId: cid, response: { value: 8 } });
    expect(await promise).toEqual({ value: 8 });
  });

  it('closed rejects bus.closed without emitting and without burning the timeout', async () => {
    // Same no-unhandled-rejection discipline as the dispose tests above: the
    // internal result promise is detached on the closed fast-fail and must
    // not surface later.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const bus = makeBus(RESULT, FAILURE, 'closed');
      const started = Date.now();
      // 30s budget: if the gate "waited out" the timeout instead of failing
      // fast, this test would blow vitest's own deadline, and the elapsed
      // check pins the intent explicitly.
      await expect(busRequest(bus, EMIT, {}, 30_000)).rejects.toMatchObject({
        code: 'bus.closed',
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(bus.emit).not.toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('flips to closed while waiting → rejects bus.closed without emitting or burning the timeout', async () => {
    // The race-arm closed path: stop()/dispose() lands MID-WAIT, after the
    // synchronous sample saw a non-deliverable, non-closed state.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const bus = makeBus(RESULT, FAILURE, 'connecting');
      const started = Date.now();
      const promise = busRequest(bus, EMIT, {}, 30_000);

      await new Promise((r) => setTimeout(r, 10));
      bus.stateSubject.next('closed');

      await expect(promise).rejects.toMatchObject({ code: 'bus.closed' });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(bus.emit).not.toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('state$ completing while waiting is treated as closed (defaultIfEmpty)', async () => {
    // A transport torn down so hard its state stream just ends: no 'closed'
    // event, no reply-stream completion — only state$ completing. The gate
    // must not hang on a vanished state machine.
    const bus = makeBus(RESULT, FAILURE, 'connecting');
    const promise = busRequest(bus, EMIT, {}, 30_000);

    await new Promise((r) => setTimeout(r, 10));
    bus.stateSubject.complete();

    await expect(promise).rejects.toMatchObject({ code: 'bus.closed' });
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('one deadline from the call (D4): a primitive that never attaches rejects bus.timeout at timeoutMs, emit never called', async () => {
    const bus = makeBus(RESULT, FAILURE, 'connecting');
    const started = Date.now();

    await expect(busRequest(bus, EMIT, {}, 80)).rejects.toMatchObject({
      code: 'bus.timeout',
    });

    // At timeoutMs — not timeoutMs + a separate gate wait. A serial
    // gate-then-timeout implementation would never reject at all here
    // (the gate has no deadline of its own to fire).
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('a state flap after emission does not re-emit (D5)', async () => {
    const bus = makeBus(RESULT, FAILURE, 'open');
    const promise = busRequest(bus, EMIT, {});

    await vi.waitFor(() => expect(bus.emit).toHaveBeenCalledTimes(1));

    // Flap: the swap window the actor transition table names.
    bus.stateSubject.next('reconnecting');
    bus.stateSubject.next('connecting');
    bus.stateSubject.next('open');
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.emit).toHaveBeenCalledTimes(1);

    const cid = bus.emitPayload!.correlationId as string;
    bus.resultSubject.next({ correlationId: cid, response: { value: 9 } });
    expect(await promise).toEqual({ value: 9 });
  });
});

describe('BusRequestError', () => {
  it('is a SemiontError with the structured code on `code`', () => {
    const err = new BusRequestError('boom', 'bus.timeout', { foo: 'bar' });
    expect(err).toBeInstanceOf(BusRequestError);
    expect(err).toBeInstanceOf(SemiontError);
    expect(err.code).toBe('bus.timeout');
    expect(err.name).toBe('BusRequestError');
    expect(err.message).toBe('boom');
    expect(err.details).toEqual({ foo: 'bar' });
  });

  it('details is optional', () => {
    const err = new BusRequestError('x', 'bus.rejected');
    expect(err.details).toBeUndefined();
  });
});

// ── BUS-RESUMPTION.md Phase 2 (SDK-DEBT S1): reply tracking ───────────────

describe('busRequest reply tracking (correlated-reply retention, client side)', () => {
  const EMIT = 'gather:resource-requested';
  const RESULT = 'gather:resource-complete';
  const FAILURE = 'gather:resource-failed';

  function makeTrackingBus(initialState: ConnectionState = 'open') {
    const bus = makeBus(RESULT, FAILURE, initialState);
    const order: string[] = [];
    const tracked: string[] = [];
    const released: string[] = [];
    const originalEmit = bus.emit;
    bus.emit = vi.fn(async (channel, payload) => {
      order.push('emit');
      return originalEmit(channel, payload);
    }) as BusRequestPrimitive['emit'];
    const trackingBus = Object.assign(bus, {
      trackReply: vi.fn((cid: string) => {
        order.push('track');
        tracked.push(cid);
        return () => {
          released.push(cid);
        };
      }),
    });
    return { bus: trackingBus, order, tracked, released };
  }

  it('tracks the cid BEFORE the emit and releases on the success reply', async () => {
    const { bus, order, tracked, released } = makeTrackingBus();
    const promise = busRequest(bus, EMIT, {});
    await Promise.resolve();

    const cid = bus.emitPayload!.correlationId as string;
    // Track-before-emit is load-bearing: a reconnect body built during the
    // emit's in-flight window must already carry the cid (see the plan).
    expect(order).toEqual(['track', 'emit']);
    expect(tracked).toEqual([cid]);
    expect(released).toEqual([]);

    bus.resultSubject.next({ correlationId: cid, response: { value: 1 } });
    await promise;
    expect(released).toEqual([cid]);
  });

  it('releases on a failure reply', async () => {
    const { bus, tracked, released } = makeTrackingBus();
    const promise = busRequest(bus, EMIT, {});
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.failureSubject.next({ correlationId: cid, message: 'nope' });
    await expect(promise).rejects.toMatchObject({ code: 'bus.rejected' });
    expect(tracked).toEqual([cid]);
    expect(released).toEqual([cid]);
  });

  it('releases on timeout', async () => {
    const { bus, released } = makeTrackingBus();
    const promise = busRequest(bus, EMIT, {}, 20);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    await expect(promise).rejects.toMatchObject({ code: 'bus.timeout' });
    expect(released).toEqual([cid]);
  });

  it('releases when the bus closes before a reply (streams complete)', async () => {
    const { bus, released } = makeTrackingBus();
    const promise = busRequest(bus, EMIT, {});
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.resultSubject.complete();
    bus.failureSubject.complete();
    await expect(promise).rejects.toMatchObject({ code: 'bus.closed' });
    expect(released).toEqual([cid]);
  });

  it('releases on emit rejection', async () => {
    const { bus, released, tracked } = makeTrackingBus();
    bus.emit = vi.fn(async () => {
      throw new Error('emit refused');
    }) as BusRequestPrimitive['emit'];

    await expect(busRequest(bus, EMIT, {})).rejects.toThrow('emit refused');
    expect(tracked).toHaveLength(1);
    expect(released).toEqual(tracked);
  });

  it('never tracks when the bus is closed before emit (gate fast-fail)', async () => {
    const { bus, tracked } = makeTrackingBus('closed');
    await expect(busRequest(bus, EMIT, {})).rejects.toMatchObject({ code: 'bus.closed' });
    expect(tracked).toEqual([]);
  });

  it("never tracks when the reply machinery settles before the gate opens (the 'settled' race arm)", async () => {
    const { bus, tracked } = makeTrackingBus('connecting');
    // Never opens: the reply timeout settles first, the emit is skipped.
    await expect(busRequest(bus, EMIT, {}, 20)).rejects.toMatchObject({ code: 'bus.timeout' });
    expect(bus.emit).not.toHaveBeenCalled();
    expect(tracked).toEqual([]);
  });

  it('a primitive without trackReply behaves exactly as today', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest(bus, EMIT, {});
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;
    bus.resultSubject.next({ correlationId: cid, response: { ok: 1 } });
    expect(await promise).toEqual({ ok: 1 });
  });
});
