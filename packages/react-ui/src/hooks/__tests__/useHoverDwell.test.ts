/**
 * useHoverDwell: one hover dwell per session and delay, disposed when either
 * changes or the component unmounts, so a rest in flight never outlives them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { annotationId } from '@semiont/core';
import type { HoverDwell, SemiontSession } from '@semiont/sdk';
import { useHoverDwell } from '../useHoverDwell';

function sessionDouble() {
  const hover = vi.fn();
  const session = { client: { beckon: { hover } } } as unknown as SemiontSession;
  return { session, hover };
}

function made(dwell: HoverDwell | undefined): HoverDwell {
  if (!dwell) throw new Error('no dwell was made');
  return dwell;
}

const ANN = annotationId('ann-1');

describe('useHoverDwell', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('says the annotation the pointer rests on, once it has rested for the delay', () => {
    const { session, hover } = sessionDouble();
    const { result } = renderHook(() => useHoverDwell(session, 100));

    made(result.current).enter(ANN);
    vi.advanceTimersByTime(99);
    expect(hover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(hover.mock.calls).toEqual([[ANN]]);
  });

  it('forgets a rest in flight when the component unmounts', () => {
    const { session, hover } = sessionDouble();
    const { result, unmount } = renderHook(() => useHoverDwell(session, 100));

    made(result.current).enter(ANN);
    unmount();
    vi.advanceTimersByTime(200);

    expect(hover).not.toHaveBeenCalled();
  });

  it('makes a new dwell when the delay changes, and forgets the old one\'s rest', () => {
    const { session, hover } = sessionDouble();
    const { result, rerender } = renderHook(({ delay }) => useHoverDwell(session, delay), { initialProps: { delay: 100 } });
    const first = made(result.current);

    first.enter(ANN);
    rerender({ delay: 300 });
    vi.advanceTimersByTime(200);
    expect(hover).not.toHaveBeenCalled();
    expect(result.current).not.toBe(first);

    made(result.current).enter(ANN);
    vi.advanceTimersByTime(299);
    expect(hover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hover.mock.calls).toEqual([[ANN]]);
  });

  it('makes a new dwell for a new session, and says nothing more to the old one', () => {
    const old = sessionDouble();
    const next = sessionDouble();
    const { result, rerender } = renderHook(({ session }) => useHoverDwell(session, 100), { initialProps: { session: old.session } });

    made(result.current).enter(ANN);
    rerender({ session: next.session });
    vi.advanceTimersByTime(200);
    made(result.current).enter(ANN);
    vi.advanceTimersByTime(100);

    expect(old.hover).not.toHaveBeenCalled();
    expect(next.hover.mock.calls).toEqual([[ANN]]);
  });

  it('has none while there is no session', () => {
    const { result } = renderHook(() => useHoverDwell(undefined, 100));

    expect(result.current).toBeUndefined();
  });
});
