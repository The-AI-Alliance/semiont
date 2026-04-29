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
