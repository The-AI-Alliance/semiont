/**
 * EventBus + busLog integration.
 *
 * The `__SEMIONT_BUS_LOG__` flag (or `SEMIONT_BUS_LOG=1` env var)
 * makes `EventBus.get(channel).next(payload)` also emit a
 * `[bus EMIT] <channel> ...` line on `console.debug`. This is what
 * makes local-only fan-out signals (`beckon.hover`, `beckon.sparkle`,
 * `mark.changeShape`, etc.) visible to the e2e bus capture and to a
 * developer's DevTools console.
 *
 * Without this, those signals were silent at the wire-log layer
 * because they don't go through HttpTransport — they're in-memory
 * only. Spec 08 (hover-beckon) assumed they'd appear in the capture
 * and was effectively un-runnable until this wiring landed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../event-bus';

describe('EventBus busLog integration', () => {
  let savedFlag: unknown;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedFlag = (globalThis as { __SEMIONT_BUS_LOG__?: boolean }).__SEMIONT_BUS_LOG__;
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedFlag === undefined) {
      delete (globalThis as { __SEMIONT_BUS_LOG__?: boolean }).__SEMIONT_BUS_LOG__;
    } else {
      (globalThis as { __SEMIONT_BUS_LOG__?: boolean }).__SEMIONT_BUS_LOG__ = savedFlag as boolean;
    }
    debugSpy.mockRestore();
  });

  it('emits a [bus EMIT] line on console.debug when the flag is set', () => {
    (globalThis as { __SEMIONT_BUS_LOG__?: boolean }).__SEMIONT_BUS_LOG__ = true;

    const bus = new EventBus();
    bus.get('beckon:hover').next({ annotationId: 'ann-1' as never });

    expect(debugSpy).toHaveBeenCalled();
    const line = debugSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('[bus EMIT]');
    expect(line).toContain('beckon:hover');
  });

  it('does NOT log when the flag is not set', () => {
    delete (globalThis as { __SEMIONT_BUS_LOG__?: boolean }).__SEMIONT_BUS_LOG__;

    const bus = new EventBus();
    bus.get('beckon:hover').next({ annotationId: 'ann-1' as never });

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('still delivers payloads to subscribers when the flag is set', () => {
    (globalThis as { __SEMIONT_BUS_LOG__?: boolean }).__SEMIONT_BUS_LOG__ = true;

    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.get('beckon:hover').subscribe((p) => seen.push(p));
    bus.get('beckon:hover').next({ annotationId: 'ann-1' as never });

    expect(seen).toEqual([{ annotationId: 'ann-1' }]);
  });
});

/**
 * Dropped-reply detector — the silent-failure guard from
 * .plans/bugs/gather-resource-complete-not-bridged.md. A correlation-bearing
 * reply emitted with zero observers is unreachable (no forwarder, no consumer),
 * so the awaiting client times out 30 s later with no error. On Node this WARNs
 * once per channel at emit time. Each test uses a DISTINCT channel because the
 * once-per-channel dedup is process-global.
 */
describe('EventBus dropped-reply detection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('WARNs when a correlation reply is emitted with no observers', () => {
    const bus = new EventBus();
    bus.get('gather:resource-complete').next({ correlationId: 'deadbeef-1', response: {} } as never);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('[bus DROP]');
    expect(line).toContain('gather:resource-complete');
    expect(line).toContain('cid=deadbeef');
  });

  it('does NOT warn when the reply has an observer', () => {
    const bus = new EventBus();
    bus.get('gather:resource-failed').subscribe(() => {});
    bus.get('gather:resource-failed').next({ correlationId: 'deadbeef-2' } as never);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for a non-reply emit (no correlationId) with no observers', () => {
    const bus = new EventBus();
    bus.get('match:search-results').next({} as never);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns only once per channel (a missing wiring is reported, not spammed)', () => {
    const bus = new EventBus();
    bus.get('browse:resource-result').next({ correlationId: 'deadbeef-3' } as never);
    bus.get('browse:resource-result').next({ correlationId: 'deadbeef-4' } as never);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
