import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFormattedTime } from '../useFormattedTime';

describe('useFormattedTime', () => {
  describe('Basic Functionality', () => {
    it('should format time with hours and minutes', () => {
      const { result } = renderHook(() => useFormattedTime(3661000)); // 1h 1m 1s
      expect(result.current).toBe('1h 1m');
    });

    it('should format time with only minutes', () => {
      const { result } = renderHook(() => useFormattedTime(120000)); // 2m
      expect(result.current).toBe('2m');
    });

    it('should round up seconds > 30 to 1m', () => {
      const { result } = renderHook(() => useFormattedTime(31000)); // 31 seconds
      expect(result.current).toBe('1m');
    });

    it('should return "Less than 1m" for seconds <= 30', () => {
      const { result } = renderHook(() => useFormattedTime(30000)); // 30 seconds
      expect(result.current).toBe('Less than 1m');
    });

    it('should return "Less than 1m" for very small values', () => {
      const { result } = renderHook(() => useFormattedTime(1000)); // 1 second
      expect(result.current).toBe('Less than 1m');
    });
  });

  describe('Null and Edge Cases', () => {
    it('should return null for null input', () => {
      const { result } = renderHook(() => useFormattedTime(null));
      expect(result.current).toBeNull();
    });

    it('should return null for zero', () => {
      const { result } = renderHook(() => useFormattedTime(0));
      expect(result.current).toBeNull();
    });

    it('should return null for negative values', () => {
      const { result } = renderHook(() => useFormattedTime(-1000));
      expect(result.current).toBeNull();
    });

    it('should handle very large hour values', () => {
      const { result } = renderHook(() => useFormattedTime(360000000)); // 100 hours
      expect(result.current).toBe('100h 0m');
    });

    it('should handle very large values with hours and minutes', () => {
      const { result } = renderHook(() => useFormattedTime(3723000)); // 1h 2m 3s
      expect(result.current).toBe('1h 2m');
    });
  });

  describe('Exact Time Boundaries', () => {
    it('should format exactly 1 hour', () => {
      const { result } = renderHook(() => useFormattedTime(3600000));
      expect(result.current).toBe('1h 0m');
    });

    it('should format exactly 1 minute', () => {
      const { result } = renderHook(() => useFormattedTime(60000));
      expect(result.current).toBe('1m');
    });

    it('should handle 30 seconds (boundary)', () => {
      const { result } = renderHook(() => useFormattedTime(30000));
      expect(result.current).toBe('Less than 1m');
    });

    it('should handle 31 seconds (just over boundary)', () => {
      const { result } = renderHook(() => useFormattedTime(31000));
      expect(result.current).toBe('1m');
    });

    it('should handle 59 seconds', () => {
      const { result } = renderHook(() => useFormattedTime(59000));
      expect(result.current).toBe('1m');
    });

    it('should handle 1 millisecond', () => {
      const { result } = renderHook(() => useFormattedTime(1));
      expect(result.current).toBe('Less than 1m');
    });
  });

  describe('Hour Formatting', () => {
    it('should show 0 minutes when hour has no remainder', () => {
      const { result } = renderHook(() => useFormattedTime(7200000)); // 2h
      expect(result.current).toBe('2h 0m');
    });

    it('should show correct minutes with hours', () => {
      const { result } = renderHook(() => useFormattedTime(5400000)); // 1h 30m
      expect(result.current).toBe('1h 30m');
    });

    it('should handle 10+ hours', () => {
      const { result } = renderHook(() => useFormattedTime(39600000)); // 11h
      expect(result.current).toBe('11h 0m');
    });

    it('should handle 24 hours', () => {
      const { result } = renderHook(() => useFormattedTime(86400000)); // 24h
      expect(result.current).toBe('24h 0m');
    });
  });

  describe('Minute Formatting', () => {
    it('should show minutes without hours', () => {
      const { result } = renderHook(() => useFormattedTime(300000)); // 5m
      expect(result.current).toBe('5m');
    });

    it('should handle 59 minutes', () => {
      const { result } = renderHook(() => useFormattedTime(3540000)); // 59m
      expect(result.current).toBe('59m');
    });

    it('should handle 15 minutes', () => {
      const { result } = renderHook(() => useFormattedTime(900000)); // 15m
      expect(result.current).toBe('15m');
    });

    it('should ignore seconds in minute display', () => {
      const { result } = renderHook(() => useFormattedTime(125000)); // 2m 5s
      expect(result.current).toBe('2m');
    });
  });

  describe('Memoization', () => {
    it('should return same reference for same input', () => {
      const { result, rerender } = renderHook(
        ({ ms }) => useFormattedTime(ms),
        { initialProps: { ms: 60000 } }
      );

      const firstResult = result.current;

      // Rerender with same value
      rerender({ ms: 60000 });

      expect(result.current).toBe(firstResult);
      expect(result.current).toBe('1m');
    });

    it('should update when input changes', () => {
      const { result, rerender } = renderHook(
        ({ ms }) => useFormattedTime(ms),
        { initialProps: { ms: 60000 } }
      );

      expect(result.current).toBe('1m');

      // Update to different value
      rerender({ ms: 120000 });

      expect(result.current).toBe('2m');
    });

    it('should return null reference consistently', () => {
      const { result, rerender } = renderHook(
        ({ ms }) => useFormattedTime(ms),
        { initialProps: { ms: null } }
      );

      const firstNull = result.current;

      rerender({ ms: null });

      expect(result.current).toBe(firstNull);
      expect(result.current).toBeNull();
    });

    it('should update from null to value', () => {
      const { result, rerender } = renderHook(
        ({ ms }) => useFormattedTime(ms),
        { initialProps: { ms: null } }
      );

      expect(result.current).toBeNull();

      rerender({ ms: 60000 });

      expect(result.current).toBe('1m');
    });

    it('should update from value to null', () => {
      const { result, rerender } = renderHook(
        ({ ms }) => useFormattedTime(ms),
        { initialProps: { ms: 60000 } }
      );

      expect(result.current).toBe('1m');

      rerender({ ms: null });

      expect(result.current).toBeNull();
    });
  });

  describe('Real-World Scenarios', () => {
    it('should format session expiry time (5 minutes)', () => {
      const { result } = renderHook(() => useFormattedTime(300000));
      expect(result.current).toBe('5m');
    });

    it('should format session expiry time (30 minutes)', () => {
      const { result } = renderHook(() => useFormattedTime(1800000));
      expect(result.current).toBe('30m');
    });

    it('should format session expiry time (1 hour)', () => {
      const { result } = renderHook(() => useFormattedTime(3600000));
      expect(result.current).toBe('1h 0m');
    });

    it('should format session expiry time (2 hours 30 minutes)', () => {
      const { result } = renderHook(() => useFormattedTime(9000000));
      expect(result.current).toBe('2h 30m');
    });

    it('should handle countdown approaching expiry (45 seconds)', () => {
      const { result } = renderHook(() => useFormattedTime(45000));
      expect(result.current).toBe('1m');
    });

    it('should handle countdown approaching expiry (15 seconds)', () => {
      const { result } = renderHook(() => useFormattedTime(15000));
      expect(result.current).toBe('Less than 1m');
    });

    it('should handle expired session (0)', () => {
      const { result } = renderHook(() => useFormattedTime(0));
      expect(result.current).toBeNull();
    });
  });

  describe('Time Calculations', () => {
    it('should correctly calculate hours component', () => {
      // 4h 23m 17s = 15797000ms
      const { result } = renderHook(() => useFormattedTime(15797000));
      expect(result.current).toBe('4h 23m');
    });

    it('should correctly calculate minutes component without hours', () => {
      // 43m 12s = 2592000ms
      const { result } = renderHook(() => useFormattedTime(2592000));
      expect(result.current).toBe('43m');
    });

    it('should ignore milliseconds in calculations', () => {
      // 1m 30s 500ms
      const { result } = renderHook(() => useFormattedTime(90500));
      expect(result.current).toBe('1m');
    });

    it('should floor fractional minutes', () => {
      // 1m 59.9s (rounds down to 1m, not 2m)
      const { result } = renderHook(() => useFormattedTime(119900));
      expect(result.current).toBe('1m');
    });

    it('should floor fractional hours', () => {
      // 1h 59m 59s
      const { result } = renderHook(() => useFormattedTime(7199000));
      expect(result.current).toBe('1h 59m');
    });
  });

  describe('Consistency', () => {
    it('should return consistent results for same input', () => {
      const input = 123456;
      const { result: result1 } = renderHook(() => useFormattedTime(input));
      const { result: result2 } = renderHook(() => useFormattedTime(input));

      expect(result1.current).toBe(result2.current);
    });

    it('should handle rapid rerenders with same value', () => {
      const { result, rerender } = renderHook(
        ({ ms }) => useFormattedTime(ms),
        { initialProps: { ms: 60000 } }
      );

      const initial = result.current;

      // Multiple rerenders
      for (let i = 0; i < 10; i++) {
        rerender({ ms: 60000 });
      }

      expect(result.current).toBe(initial);
      expect(result.current).toBe('1m');
    });

    it('should handle rapid value changes', () => {
      const { result, rerender } = renderHook(
        ({ ms }) => useFormattedTime(ms),
        { initialProps: { ms: 60000 } }
      );

      const values = [120000, 180000, 240000, 300000];

      values.forEach((ms, index) => {
        rerender({ ms });
        expect(result.current).toBe(`${index + 2}m`);
      });
    });
  });
});
