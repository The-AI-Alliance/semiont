import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedCallback } from '../useDebounce';

describe('useDebouncedCallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Basic Functionality', () => {
    it('should debounce function calls', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      // Call the debounced function multiple times quickly
      act(() => {
        result.current('arg1');
        result.current('arg2');
        result.current('arg3');
      });

      // Callback should not be called immediately
      expect(callback).not.toHaveBeenCalled();

      // Fast-forward time
      act(() => {
        vi.advanceTimersByTime(500);
      });

      // Callback should be called only once with the last arguments
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('arg3');
    });

    it('should call callback with correct arguments', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 300));

      act(() => {
        result.current('test', 123, { key: 'value' });
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(callback).toHaveBeenCalledWith('test', 123, { key: 'value' });
    });

    it('should respect custom delay', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 1000));

      act(() => {
        result.current();
      });

      // Should not be called before delay
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(callback).not.toHaveBeenCalled();

      // Should be called after delay
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should cancel previous timeout on new call', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      act(() => {
        result.current('first');
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      // Call again before first timeout completes
      act(() => {
        result.current('second');
      });

      // Complete the delay for the second call
      act(() => {
        vi.advanceTimersByTime(500);
      });

      // Should only be called once with second argument
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('second');
    });
  });

  describe('Cleanup', () => {
    it('should cleanup timeout on unmount', () => {
      const callback = vi.fn();
      const { result, unmount } = renderHook(() =>
        useDebouncedCallback(callback, 500)
      );

      act(() => {
        result.current('test');
      });

      // Unmount before timeout completes
      unmount();

      // Fast-forward time
      act(() => {
        vi.advanceTimersByTime(500);
      });

      // Callback should not be called after unmount
      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle multiple rapid calls followed by unmount', () => {
      const callback = vi.fn();
      const { result, unmount } = renderHook(() =>
        useDebouncedCallback(callback, 500)
      );

      act(() => {
        result.current('call1');
        result.current('call2');
        result.current('call3');
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Callback Updates', () => {
    it('should use updated callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const { result, rerender } = renderHook(
        ({ cb }) => useDebouncedCallback(cb, 500),
        { initialProps: { cb: callback1 } }
      );

      act(() => {
        result.current('test');
      });

      // Update the callback before timeout completes
      rerender({ cb: callback2 });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      // New callback should be called, not the old one
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledWith('test');
    });

    it('should maintain timeout when callback changes', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const { result, rerender } = renderHook(
        ({ cb }) => useDebouncedCallback(cb, 500),
        { initialProps: { cb: callback1 } }
      );

      act(() => {
        result.current('arg');
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      // Update callback mid-delay
      rerender({ cb: callback2 });

      // Complete the original delay
      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Updated callback should be called after original delay
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('Delay Updates', () => {
    it('should use updated delay for new calls', () => {
      const callback = vi.fn();

      const { result, rerender } = renderHook(
        ({ delay }) => useDebouncedCallback(callback, delay),
        { initialProps: { delay: 500 } }
      );

      // First call with 500ms delay
      act(() => {
        result.current('first');
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(callback).toHaveBeenCalledTimes(1);
      callback.mockClear();

      // Update delay
      rerender({ delay: 1000 });

      // New call should use new delay
      act(() => {
        result.current('second');
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(callback).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero delay', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 0));

      act(() => {
        result.current('test');
      });

      act(() => {
        vi.advanceTimersByTime(0);
      });

      expect(callback).toHaveBeenCalledWith('test');
    });

    it('should handle very long delays', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 10000));

      act(() => {
        result.current('test');
      });

      act(() => {
        vi.advanceTimersByTime(9999);
      });
      expect(callback).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle no arguments', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      act(() => {
        result.current();
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith();
    });

    it('should handle functions as arguments', () => {
      const callback = vi.fn();
      const argFunction = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      act(() => {
        result.current(argFunction);
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(callback).toHaveBeenCalledWith(argFunction);
    });
  });

  describe('Multiple Sequential Calls', () => {
    it('should handle sequential debounced calls correctly', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      // First call
      act(() => {
        result.current('first');
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(callback).toHaveBeenCalledWith('first');
      callback.mockClear();

      // Second call after first completes
      act(() => {
        result.current('second');
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(callback).toHaveBeenCalledWith('second');
    });

    it('should reset debounce timer on each call', () => {
      const callback = vi.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      // Call 1
      act(() => {
        result.current('call1');
      });

      // Call 2 after 300ms
      act(() => {
        vi.advanceTimersByTime(300);
        result.current('call2');
      });

      // Call 3 after another 300ms
      act(() => {
        vi.advanceTimersByTime(300);
        result.current('call3');
      });

      // Still no callback yet (timer keeps resetting)
      expect(callback).not.toHaveBeenCalled();

      // Complete final delay
      act(() => {
        vi.advanceTimersByTime(500);
      });

      // Should only call once with last argument
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('call3');
    });
  });
});
