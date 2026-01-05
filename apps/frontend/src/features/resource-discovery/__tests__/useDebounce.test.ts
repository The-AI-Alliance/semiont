/**
 * Tests for useDebounce hook
 *
 * Tests debouncing behavior with timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebounce } from '../hooks/useDebounce';

describe('useDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('initial', 500));

    expect(result.current).toBe('initial');
  });

  it('delays updating value by specified delay', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'initial', delay: 500 } }
    );

    expect(result.current).toBe('initial');

    // Update the value
    rerender({ value: 'updated', delay: 500 });

    // Value should not update immediately
    expect(result.current).toBe('initial');

    // Fast-forward time by 499ms - should still be old value
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current).toBe('initial');

    // Fast-forward time by 1ms more (total 500ms) - should now be new value
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('updated');
  });

  it('resets delay on rapid value changes', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'initial', delay: 500 } }
    );

    // First update
    rerender({ value: 'first', delay: 500 });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Second update before delay completes
    rerender({ value: 'second', delay: 500 });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Third update before delay completes
    rerender({ value: 'third', delay: 500 });

    // At this point, 400ms total have passed, but delay should reset each time
    expect(result.current).toBe('initial');

    // Now advance 500ms from last update
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Should be the latest value
    expect(result.current).toBe('third');
  });

  it('works with different data types', () => {
    // Test with numbers
    const { result: numberResult, rerender: numberRerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 42, delay: 500 } }
    );

    numberRerender({ value: 100, delay: 500 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(numberResult.current).toBe(100);

    // Test with objects
    const { result: objectResult, rerender: objectRerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: { foo: 'bar' }, delay: 500 } }
    );

    objectRerender({ value: { foo: 'baz' }, delay: 500 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(objectResult.current).toEqual({ foo: 'baz' });

    // Test with arrays
    const { result: arrayResult, rerender: arrayRerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: [1, 2, 3], delay: 500 } }
    );

    arrayRerender({ value: [4, 5, 6], delay: 500 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(arrayResult.current).toEqual([4, 5, 6]);
  });

  it('respects different delay values', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'initial', delay: 1000 } }
    );

    rerender({ value: 'updated', delay: 1000 });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('initial');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('updated');
  });

  it('cancels pending timeout on unmount', () => {
    const { result, rerender, unmount } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'initial', delay: 500 } }
    );

    rerender({ value: 'updated', delay: 500 });

    // Unmount before delay completes
    unmount();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    // No error should occur, timeout should be cancelled
    expect(result.current).toBe('initial');
  });

  it('handles zero delay', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'initial', delay: 0 } }
    );

    rerender({ value: 'updated', delay: 0 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(result.current).toBe('updated');
  });
});
