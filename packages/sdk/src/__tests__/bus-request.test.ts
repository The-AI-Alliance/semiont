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
import { Observable, Subject } from 'rxjs';
import { SemiontError, type EventMap } from '@semiont/core';

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
}

function makeBus(resultChannel: string, failureChannel: string): MockBus {
  const resultSubject = new Subject<unknown>();
  const failureSubject = new Subject<unknown>();
  const bus: MockBus = {
    emitChannel: null,
    emitPayload: null,
    resultSubject,
    failureSubject,
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
  const RESULT = 'unit:result';
  const FAILURE = 'unit:failure';
  const EMIT = 'unit:request';

  it('emits the request with a generated correlationId and resolves on the matching result', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest<{ value: number }>(bus, EMIT, { foo: 'bar' }, RESULT, FAILURE);

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
    const promise = busRequest<{ value: number }>(bus, EMIT, {}, RESULT, FAILURE);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    // Wrong correlationId: must be ignored.
    bus.resultSubject.next({ correlationId: 'somebody-else', response: { value: 1 } });
    bus.resultSubject.next({ correlationId: cid, response: { value: 2 } });

    expect(await promise).toEqual({ value: 2 });
  });

  it('rejects with BusRequestError(bus.rejected) when a failure event arrives', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest<unknown>(bus, EMIT, {}, RESULT, FAILURE);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.failureSubject.next({ correlationId: cid, message: 'permission denied' });

    await expect(promise).rejects.toBeInstanceOf(BusRequestError);
    await expect(promise).rejects.toMatchObject({
      code: 'bus.rejected',
      message: 'permission denied',
      name: 'BusRequestError',
    });
  });

  it('attaches structured details on bus.rejected', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest<unknown>(bus, EMIT, {}, RESULT, FAILURE);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    const failurePayload = { correlationId: cid, message: 'denied', extra: 'context' };
    bus.failureSubject.next(failurePayload);

    try {
      await promise;
      throw new Error('expected reject');
    } catch (err) {
      expect(err).toBeInstanceOf(BusRequestError);
      const e = err as BusRequestError;
      expect(e.details).toMatchObject({
        channel: FAILURE,
        correlationId: cid,
        payload: failurePayload,
      });
    }
  });

  it('falls back to a default message when the failure event has no `message`', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest<unknown>(bus, EMIT, {}, RESULT, FAILURE);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.failureSubject.next({ correlationId: cid });

    await expect(promise).rejects.toMatchObject({
      code: 'bus.rejected',
      message: 'Bus request rejected',
    });
  });

  it('rejects with BusRequestError(bus.timeout) when no event arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const bus = makeBus(RESULT, FAILURE);
      const promise = busRequest<unknown>(bus, EMIT, {}, RESULT, FAILURE, 100);

      await vi.advanceTimersByTimeAsync(101);

      await expect(promise).rejects.toBeInstanceOf(BusRequestError);
      await expect(promise).rejects.toMatchObject({
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
      const promise = busRequest<unknown>(bus, EMIT, {}, RESULT, FAILURE, 50);
      await Promise.resolve();
      const cid = bus.emitPayload!.correlationId as string;

      await vi.advanceTimersByTimeAsync(51);

      try {
        await promise;
        throw new Error('expected reject');
      } catch (err) {
        const e = err as BusRequestError;
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
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the first matching result and ignores any after', async () => {
    const bus = makeBus(RESULT, FAILURE);
    const promise = busRequest<{ value: number }>(bus, EMIT, {}, RESULT, FAILURE);
    await Promise.resolve();
    const cid = bus.emitPayload!.correlationId as string;

    bus.resultSubject.next({ correlationId: cid, response: { value: 1 } });
    bus.resultSubject.next({ correlationId: cid, response: { value: 2 } });

    expect(await promise).toEqual({ value: 1 });
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
