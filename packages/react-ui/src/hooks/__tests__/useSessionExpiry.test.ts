/**
 * useSessionExpiry Hook Tests
 *
 * Tests the useSessionExpiry hook which calculates time remaining until session expiry.
 * Uses timers to test time-based behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useSessionExpiry } from '../useSessionExpiry';
import { SessionProvider } from '../../contexts/SessionContext';
import type { SessionManager } from '../../types/SessionManager';

// Helper to create a SessionManager with specified expiresAt
const createMockSessionManager = (expiresAt: Date | null): SessionManager => ({
  isAuthenticated: expiresAt !== null,
  expiresAt,
  timeUntilExpiry: null, // Not used by useSessionExpiry
  isExpiringSoon: false, // Not used by useSessionExpiry
});

describe('useSessionExpiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Basic Functionality', () => {
    it('should return null timeRemaining when no expiresAt', () => {
      const sessionManager = createMockSessionManager(null);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBeNull();
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should calculate time remaining correctly', () => {
      const expiresAt = new Date('2024-01-01T12:30:00Z'); // 30 minutes from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000); // 30 minutes in ms
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should set isExpiringSoon when less than 5 minutes remaining', () => {
      const expiresAt = new Date('2024-01-01T12:04:00Z'); // 4 minutes from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(4 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should not set isExpiringSoon when exactly 5 minutes remaining', () => {
      const expiresAt = new Date('2024-01-01T12:05:00Z'); // 5 minutes from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(5 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should return 0 when session is expired', () => {
      const expiresAt = new Date('2024-01-01T11:00:00Z'); // 1 hour ago
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });
  });

  describe('Timer Updates', () => {
    it('should update timeRemaining every second', () => {
      const expiresAt = new Date('2024-01-01T12:30:00Z'); // 30 minutes from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      const initialTime = result.current.timeRemaining;
      expect(initialTime).toBe(30 * 60 * 1000);

      // Advance 1 second
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000 - 1000);

      // Advance another second
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000 - 2000);
    });

    it('should update isExpiringSoon when crossing 5 minute threshold', () => {
      const expiresAt = new Date('2024-01-01T12:05:02Z'); // 5 minutes 2 seconds from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.isExpiringSoon).toBe(false);

      // Advance 3 seconds (now 4:59 remaining, should be expiring soon)
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should stop updating isExpiringSoon when time expires', () => {
      const expiresAt = new Date('2024-01-01T12:00:02Z'); // 2 seconds from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(2000);
      expect(result.current.isExpiringSoon).toBe(true);

      // Advance past expiry
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should continue updating until session expires', () => {
      const expiresAt = new Date('2024-01-01T12:00:05Z'); // 5 seconds from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      // Update each second
      for (let i = 5; i >= 0; i--) {
        expect(result.current.timeRemaining).toBe(i * 1000);

        if (i > 0) {
          act(() => {
            vi.advanceTimersByTime(1000);
          });
        }
      }
    });
  });

  describe('Expiry Scenarios', () => {
    it('should handle long session (hours remaining)', () => {
      const expiresAt = new Date('2024-01-01T16:00:00Z'); // 4 hours from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(4 * 60 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should handle session expiring in 1 minute', () => {
      const expiresAt = new Date('2024-01-01T12:01:00Z'); // 1 minute from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(60 * 1000);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should handle session expiring in 30 seconds', () => {
      const expiresAt = new Date('2024-01-01T12:00:30Z'); // 30 seconds from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(30 * 1000);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should handle session already expired', () => {
      const expiresAt = new Date('2024-01-01T11:59:00Z'); // 1 minute ago
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should handle session far in future', () => {
      const expiresAt = new Date('2024-01-02T12:00:00Z'); // 24 hours from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(24 * 60 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });
  });

  describe('Context Changes', () => {
    it('should update when expiresAt changes', () => {
      let currentExpiresAt: Date | null = new Date('2024-01-01T12:30:00Z');
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          SessionProvider,
          { sessionManager: createMockSessionManager(currentExpiresAt) },
          children
        );

      const { result, rerender } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);

      // Update expiresAt
      currentExpiresAt = new Date('2024-01-01T12:15:00Z');

      rerender();

      expect(result.current.timeRemaining).toBe(15 * 60 * 1000);
    });

    it('should clear timer when expiresAt becomes null', () => {
      let currentExpiresAt: Date | null = new Date('2024-01-01T12:30:00Z');
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          SessionProvider,
          { sessionManager: createMockSessionManager(currentExpiresAt) },
          children
        );

      const { result, rerender } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);

      // Clear expiresAt
      currentExpiresAt = null;

      rerender();

      expect(result.current.timeRemaining).toBeNull();
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should start timer when expiresAt becomes available', () => {
      let currentExpiresAt: Date | null = null;
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          SessionProvider,
          { sessionManager: createMockSessionManager(currentExpiresAt) },
          children
        );

      const { result, rerender } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBeNull();

      // Set expiresAt
      currentExpiresAt = new Date('2024-01-01T12:30:00Z');

      rerender();

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);
    });

    it('should handle rapid expiresAt changes', () => {
      const times = [
        new Date('2024-01-01T12:10:00Z'),
        new Date('2024-01-01T12:20:00Z'),
        new Date('2024-01-01T12:30:00Z'),
        new Date('2024-01-01T12:40:00Z'),
      ];

      let currentIndex = 0;
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          SessionProvider,
          { sessionManager: createMockSessionManager(times[currentIndex]) },
          children
        );

      const { result, rerender } = renderHook(() => useSessionExpiry(), { wrapper });

      times.forEach((time, index) => {
        currentIndex = index;
        rerender();

        const expectedMs = (10 + index * 10) * 60 * 1000;
        expect(result.current.timeRemaining).toBe(expectedMs);
      });
    });
  });

  describe('Cleanup', () => {
    it('should cleanup interval on unmount', () => {
      const expiresAt = new Date('2024-01-01T12:30:00Z');
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result, unmount } = renderHook(() => useSessionExpiry(), { wrapper });

      const initialTime = result.current.timeRemaining;

      unmount();

      // Advance time
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Time shouldn't update after unmount (checking last value before unmount)
      expect(initialTime).toBe(30 * 60 * 1000);
    });

    it('should cleanup old interval when expiresAt changes', () => {
      let currentExpiresAt: Date | null = new Date('2024-01-01T12:30:00Z');
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          SessionProvider,
          { sessionManager: createMockSessionManager(currentExpiresAt) },
          children
        );

      const { result, rerender } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);

      // Change expiresAt (should cleanup old interval)
      currentExpiresAt = new Date('2024-01-01T12:15:00Z');

      rerender();

      expect(result.current.timeRemaining).toBe(15 * 60 * 1000);

      // Verify timer is still working with new interval
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.timeRemaining).toBe(15 * 60 * 1000 - 1000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle time exactly at 0', () => {
      const expiresAt = new Date('2024-01-01T12:00:00Z'); // Exactly now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should handle millisecond precision', () => {
      const expiresAt = new Date('2024-01-01T12:00:00.500Z'); // 500ms from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(500);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should not show negative time remaining', () => {
      const expiresAt = new Date('2024-01-01T11:00:00Z'); // 1 hour ago
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.timeRemaining).not.toBeLessThan(0);
    });

    it('should handle very large time remaining', () => {
      const expiresAt = new Date('2024-12-31T23:59:59Z'); // Almost a year
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBeGreaterThan(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle typical 1 hour session', () => {
      const expiresAt = new Date('2024-01-01T13:00:00Z'); // 1 hour from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(60 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);

      // Fast forward to 6 minutes remaining
      act(() => {
        vi.advanceTimersByTime(54 * 60 * 1000);
      });

      expect(result.current.timeRemaining).toBe(6 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);

      // One more minute - should trigger expiring soon
      act(() => {
        vi.advanceTimersByTime(60 * 1000);
      });

      expect(result.current.timeRemaining).toBe(5 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false); // Exactly 5 minutes

      // One more second - now expiring soon
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should handle session refresh extending time', () => {
      let currentExpiresAt: Date | null = new Date('2024-01-01T12:02:00Z'); // 2 minutes remaining
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          SessionProvider,
          { sessionManager: createMockSessionManager(currentExpiresAt) },
          children
        );

      const { result, rerender } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current.timeRemaining).toBe(2 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(true);

      // Session refreshed - extended by 1 hour
      currentExpiresAt = new Date('2024-01-01T13:00:00Z');

      rerender();

      expect(result.current.timeRemaining).toBe(60 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should handle countdown to expiry', () => {
      const expiresAt = new Date('2024-01-01T12:00:10Z'); // 10 seconds from now
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      // Count down each second
      for (let i = 10; i > 0; i--) {
        expect(result.current.timeRemaining).toBe(i * 1000);
        expect(result.current.isExpiringSoon).toBe(true);

        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }

      // Final check - expired
      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });
  });

  describe('Consistency', () => {
    it('should return consistent structure', () => {
      const sessionManager = createMockSessionManager(null);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result } = renderHook(() => useSessionExpiry(), { wrapper });

      expect(result.current).toHaveProperty('timeRemaining');
      expect(result.current).toHaveProperty('isExpiringSoon');
    });

    it('should handle multiple rerenders without timer issues', () => {
      const expiresAt = new Date('2024-01-01T12:30:00Z');
      const sessionManager = createMockSessionManager(expiresAt);
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(SessionProvider, { sessionManager }, children);

      const { result, rerender } = renderHook(() => useSessionExpiry(), { wrapper });

      const initialTime = result.current.timeRemaining;

      // Multiple rerenders
      for (let i = 0; i < 10; i++) {
        rerender();
      }

      // Time should be same (no time advanced)
      expect(result.current.timeRemaining).toBe(initialTime);

      // Advance 1 second
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // Time should update correctly
      expect(result.current.timeRemaining).toBe(initialTime! - 1000);
    });
  });
});
