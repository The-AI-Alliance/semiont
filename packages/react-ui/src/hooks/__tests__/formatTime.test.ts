import { describe, it, expect } from 'vitest';
import { formatTime } from '../../lib/formatTime';

describe('formatTime', () => {
  describe('Basic Functionality', () => {
    it('should format time with hours and minutes', () => {
      expect(formatTime(3661000)).toBe('1h 1m'); // 1h 1m 1s
    });

    it('should format time with only minutes', () => {
      expect(formatTime(120000)).toBe('2m'); // 2m
    });

    it('should round up seconds > 30 to 1m', () => {
      expect(formatTime(31000)).toBe('1m'); // 31 seconds
    });

    it('should return "Less than 1m" for seconds <= 30', () => {
      expect(formatTime(30000)).toBe('Less than 1m'); // 30 seconds
    });

    it('should return "Less than 1m" for very small values', () => {
      expect(formatTime(1000)).toBe('Less than 1m'); // 1 second
    });
  });

  describe('Null and Edge Cases', () => {
    it('should return null for null input', () => {
      expect(formatTime(null)).toBeNull();
    });

    it('should return null for zero', () => {
      expect(formatTime(0)).toBeNull();
    });

    it('should return null for negative values', () => {
      expect(formatTime(-1000)).toBeNull();
    });

    it('should handle very large hour values', () => {
      expect(formatTime(360000000)).toBe('100h 0m'); // 100 hours
    });

    it('should handle very large values with hours and minutes', () => {
      expect(formatTime(3723000)).toBe('1h 2m'); // 1h 2m 3s
    });
  });

  describe('Exact Time Boundaries', () => {
    it('should format exactly 1 hour', () => {
      expect(formatTime(3600000)).toBe('1h 0m');
    });

    it('should format exactly 1 minute', () => {
      expect(formatTime(60000)).toBe('1m');
    });

    it('should handle 30 seconds (boundary)', () => {
      expect(formatTime(30000)).toBe('Less than 1m');
    });

    it('should handle 31 seconds (just over boundary)', () => {
      expect(formatTime(31000)).toBe('1m');
    });

    it('should handle 59 seconds', () => {
      expect(formatTime(59000)).toBe('1m');
    });

    it('should handle 1 millisecond', () => {
      expect(formatTime(1)).toBe('Less than 1m');
    });
  });

  describe('Hour Formatting', () => {
    it('should show 0 minutes when hour has no remainder', () => {
      expect(formatTime(7200000)).toBe('2h 0m'); // 2h
    });

    it('should show correct minutes with hours', () => {
      expect(formatTime(5400000)).toBe('1h 30m'); // 1h 30m
    });

    it('should handle 10+ hours', () => {
      expect(formatTime(39600000)).toBe('11h 0m'); // 11h
    });

    it('should handle 24 hours', () => {
      expect(formatTime(86400000)).toBe('24h 0m'); // 24h
    });
  });

  describe('Minute Formatting', () => {
    it('should show minutes without hours', () => {
      expect(formatTime(300000)).toBe('5m'); // 5m
    });

    it('should handle 59 minutes', () => {
      expect(formatTime(3540000)).toBe('59m'); // 59m
    });

    it('should handle 15 minutes', () => {
      expect(formatTime(900000)).toBe('15m'); // 15m
    });

    it('should ignore seconds in minute display', () => {
      expect(formatTime(125000)).toBe('2m'); // 2m 5s
    });
  });

  describe('Consistency', () => {
    it('should return consistent results for same input', () => {
      const input = 123456;
      expect(formatTime(input)).toBe(formatTime(input));
    });

    it('should handle rapid calls with same value', () => {
      const result = formatTime(60000);
      for (let i = 0; i < 10; i++) {
        expect(formatTime(60000)).toBe(result);
      }
      expect(result).toBe('1m');
    });

    it('should handle different values correctly', () => {
      const values = [120000, 180000, 240000, 300000];
      values.forEach((ms, index) => {
        expect(formatTime(ms)).toBe(`${index + 2}m`);
      });
    });
  });

  describe('Real-World Scenarios', () => {
    it('should format session expiry time (5 minutes)', () => {
      expect(formatTime(300000)).toBe('5m');
    });

    it('should format session expiry time (30 minutes)', () => {
      expect(formatTime(1800000)).toBe('30m');
    });

    it('should format session expiry time (1 hour)', () => {
      expect(formatTime(3600000)).toBe('1h 0m');
    });

    it('should format session expiry time (2 hours 30 minutes)', () => {
      expect(formatTime(9000000)).toBe('2h 30m');
    });

    it('should handle countdown approaching expiry (45 seconds)', () => {
      expect(formatTime(45000)).toBe('1m');
    });

    it('should handle countdown approaching expiry (15 seconds)', () => {
      expect(formatTime(15000)).toBe('Less than 1m');
    });

    it('should handle expired session (0)', () => {
      expect(formatTime(0)).toBeNull();
    });
  });

  describe('Time Calculations', () => {
    it('should correctly calculate hours component', () => {
      // 4h 23m 17s = 15797000ms
      expect(formatTime(15797000)).toBe('4h 23m');
    });

    it('should correctly calculate minutes component without hours', () => {
      // 43m 12s = 2592000ms
      expect(formatTime(2592000)).toBe('43m');
    });

    it('should ignore milliseconds in calculations', () => {
      // 1m 30s 500ms
      expect(formatTime(90500)).toBe('1m');
    });

    it('should floor fractional minutes', () => {
      // 1m 59.9s (rounds down to 1m, not 2m)
      expect(formatTime(119900)).toBe('1m');
    });

    it('should floor fractional hours', () => {
      // 1h 59m 59s
      expect(formatTime(7199000)).toBe('1h 59m');
    });
  });
});
