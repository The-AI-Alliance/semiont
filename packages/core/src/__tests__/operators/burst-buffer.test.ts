import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject } from 'rxjs';
import { burstBuffer } from '../../operators/burst-buffer';

describe('burstBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const defaults = { burstWindowMs: 50, maxBatchSize: 500, idleTimeoutMs: 200 };

  it('should emit first event immediately in passthrough mode', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));
    source.next(1);

    // First event emits synchronously (leading edge)
    expect(emissions).toEqual([1]);
  });

  it('should buffer second event arriving within burst window', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next(1); // immediate
    source.next(2); // buffered

    // Only first event emitted so far
    expect(emissions).toEqual([1]);

    // After burst window, buffer flushes
    vi.advanceTimersByTime(50);
    expect(emissions).toEqual([1, [2]]);
  });

  it('should batch multiple events during a burst', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next(1); // immediate
    source.next(2); // buffered
    source.next(3); // buffered
    source.next(4); // buffered

    expect(emissions).toEqual([1]);

    vi.advanceTimersByTime(50);
    expect(emissions).toEqual([1, [2, 3, 4]]);
  });

  it('should debounce: reset burst timer on each new event', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next(1); // immediate
    vi.advanceTimersByTime(30); // 30ms in
    source.next(2); // resets burst timer
    vi.advanceTimersByTime(30); // 60ms total, but only 30ms since last event
    expect(emissions).toEqual([1]); // not yet flushed

    vi.advanceTimersByTime(20); // 80ms total, 50ms since last event
    expect(emissions).toEqual([1, [2]]); // now flushed
  });

  it('should force flush at maxBatchSize', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];
    const opts = { burstWindowMs: 50, maxBatchSize: 3, idleTimeoutMs: 200 };

    source.pipe(burstBuffer(opts)).subscribe(v => emissions.push(v));

    source.next(1); // immediate
    source.next(2); // buffered
    source.next(3); // buffered
    source.next(4); // buffered → hits maxBatchSize=3, flush

    // First event immediate, then batch of 3 when maxBatchSize hit
    expect(emissions).toEqual([1, [2, 3, 4]]);
  });

  it('should return to passthrough after idle timeout', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next(1); // immediate
    source.next(2); // buffered

    // Flush after burst window
    vi.advanceTimersByTime(50);
    expect(emissions).toEqual([1, [2]]);

    // Wait for idle timeout to return to passthrough
    vi.advanceTimersByTime(200);

    // Next event should be immediate (passthrough mode)
    source.next(3);
    expect(emissions).toEqual([1, [2], 3]);
  });

  it('should stay in accumulating mode if events keep arriving before idle timeout', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next(1); // immediate
    source.next(2); // buffered

    // Flush first batch
    vi.advanceTimersByTime(50);
    expect(emissions).toEqual([1, [2]]);

    // Before idle timeout expires, send another event
    vi.advanceTimersByTime(100); // 100ms into 200ms idle timeout
    source.next(3); // should be buffered (still in accumulating)

    vi.advanceTimersByTime(50);
    expect(emissions).toEqual([1, [2], [3]]);
  });

  it('should flush remaining buffer on complete', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];
    let completed = false;

    source.pipe(burstBuffer(defaults)).subscribe({
      next: v => emissions.push(v),
      complete: () => { completed = true; },
    });

    source.next(1); // immediate
    source.next(2); // buffered
    source.next(3); // buffered

    // Complete before burst timer fires
    source.complete();

    expect(emissions).toEqual([1, [2, 3]]);
    expect(completed).toBe(true);
  });

  it('should flush remaining buffer on error', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];
    let receivedError: Error | null = null;

    source.pipe(burstBuffer(defaults)).subscribe({
      next: v => emissions.push(v),
      error: err => { receivedError = err; },
    });

    source.next(1); // immediate
    source.next(2); // buffered

    const testError = new Error('test');
    source.error(testError);

    expect(emissions).toEqual([1, [2]]);
    expect(receivedError).toBe(testError);
  });

  it('should clean up timers on unsubscribe', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    const subscription = source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next(1); // immediate → burst timer started
    source.next(2); // buffered

    subscription.unsubscribe();

    // Advancing timers should not cause any emissions or errors
    vi.advanceTimersByTime(500);
    expect(emissions).toEqual([1]);
  });

  it('should handle single event followed by long silence then another single event', () => {
    const source = new Subject<string>();
    const emissions: (string | string[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next('a'); // immediate
    vi.advanceTimersByTime(50); // burst window
    vi.advanceTimersByTime(200); // idle timeout → back to passthrough

    source.next('b'); // immediate (passthrough)
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(200);

    source.next('c'); // immediate (passthrough)

    expect(emissions).toEqual(['a', 'b', 'c']);
  });

  it('should handle rapid multi-batch scenario with maxBatchSize', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];
    const opts = { burstWindowMs: 50, maxBatchSize: 2, idleTimeoutMs: 200 };

    source.pipe(burstBuffer(opts)).subscribe(v => emissions.push(v));

    source.next(1); // immediate
    source.next(2); // buffered
    source.next(3); // buffered → hits maxBatchSize, flush [2,3]
    source.next(4); // buffered
    source.next(5); // buffered → hits maxBatchSize, flush [4,5]

    expect(emissions).toEqual([1, [2, 3], [4, 5]]);
  });

  it('should not emit empty arrays', () => {
    const source = new Subject<number>();
    const emissions: (number | number[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    source.next(1); // immediate

    // Burst timer fires with empty buffer
    vi.advanceTimersByTime(50);

    // Idle timer fires
    vi.advanceTimersByTime(200);

    // Complete with empty buffer
    source.complete();

    expect(emissions).toEqual([1]);
  });

  it('should work with objects (not just primitives)', () => {
    type Event = { type: string; id: number };
    const source = new Subject<Event>();
    const emissions: (Event | Event[])[] = [];

    source.pipe(burstBuffer(defaults)).subscribe(v => emissions.push(v));

    const e1 = { type: 'resource.created', id: 1 };
    const e2 = { type: 'annotation.added', id: 2 };
    const e3 = { type: 'annotation.added', id: 3 };

    source.next(e1); // immediate
    source.next(e2); // buffered
    source.next(e3); // buffered

    vi.advanceTimersByTime(50);

    expect(emissions).toEqual([e1, [e2, e3]]);
  });
});
