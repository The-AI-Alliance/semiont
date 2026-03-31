/**
 * useObservable tests
 *
 * Tests that the hook subscribes to an Observable, returns the current value,
 * and unsubscribes on unmount.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { BehaviorSubject, Subject } from 'rxjs';
import { useObservable } from '../useObservable';

describe('useObservable', () => {
  it('returns undefined before any emission', () => {
    const subject = new Subject<string>();
    const { result } = renderHook(() => useObservable(subject));
    expect(result.current).toBeUndefined();
  });

  it('returns the initial value of a BehaviorSubject', () => {
    const subject = new BehaviorSubject<string>('hello');
    const { result } = renderHook(() => useObservable(subject));
    expect(result.current).toBe('hello');
  });

  it('updates when the observable emits', () => {
    const subject = new BehaviorSubject<number>(1);
    const { result } = renderHook(() => useObservable(subject));

    expect(result.current).toBe(1);

    act(() => { subject.next(2); });
    expect(result.current).toBe(2);

    act(() => { subject.next(3); });
    expect(result.current).toBe(3);
  });

  it('unsubscribes on unmount (no state updates after unmount)', () => {
    const subject = new BehaviorSubject<number>(0);
    const { result, unmount } = renderHook(() => useObservable(subject));

    expect(result.current).toBe(0);
    unmount();

    // This would throw "Can't perform a React state update on an unmounted component"
    // in older React versions; here we just verify no error is thrown
    act(() => { subject.next(99); });
    expect(result.current).toBe(0); // still the last value before unmount
  });

  it('re-subscribes when the observable reference changes', () => {
    let obs = new BehaviorSubject<string>('a');
    const { result, rerender } = renderHook(() => useObservable(obs));

    expect(result.current).toBe('a');

    act(() => { obs = new BehaviorSubject<string>('b'); });
    rerender();

    expect(result.current).toBe('b');
  });

  it('handles object values', () => {
    const subject = new BehaviorSubject<{ count: number }>({ count: 0 });
    const { result } = renderHook(() => useObservable(subject));

    expect(result.current).toEqual({ count: 0 });

    act(() => { subject.next({ count: 5 }); });
    expect(result.current).toEqual({ count: 5 });
  });

  it('handles undefined emissions', () => {
    const subject = new BehaviorSubject<string | undefined>('value');
    const { result } = renderHook(() => useObservable(subject));

    expect(result.current).toBe('value');

    act(() => { subject.next(undefined); });
    expect(result.current).toBeUndefined();
  });

  it('unsubscribes the previous subscription when observable changes', () => {
    const unsubscribeSpy = vi.fn();
    const firstSubject = new BehaviorSubject<string>('first');

    // Spy on the subscribe method to capture unsubscribe
    const originalSubscribe = firstSubject.subscribe.bind(firstSubject);
    vi.spyOn(firstSubject, 'subscribe').mockImplementation((...args) => {
      const sub = originalSubscribe(...(args as Parameters<typeof originalSubscribe>));
      const originalUnsub = sub.unsubscribe.bind(sub);
      sub.unsubscribe = () => {
        unsubscribeSpy();
        originalUnsub();
      };
      return sub;
    });

    const secondSubject = new BehaviorSubject<string>('second');
    let currentObs = firstSubject as typeof firstSubject | typeof secondSubject;

    const { rerender } = renderHook(() => useObservable(currentObs));

    // Switch observable
    act(() => { currentObs = secondSubject; });
    rerender();

    expect(unsubscribeSpy).toHaveBeenCalled();
  });
});
