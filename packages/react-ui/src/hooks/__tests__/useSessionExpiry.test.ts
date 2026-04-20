/**
 * useSessionExpiry Hook Tests
 *
 * Tests the useSessionExpiry hook which calculates time remaining until session expiry.
 * Drives the hook via a minimal fake SemiontBrowser whose activeSession$ carries a
 * session-like object with a controllable `expiresAt` getter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { BehaviorSubject } from 'rxjs';
import { useSessionExpiry } from '../useSessionExpiry';
import { SemiontProvider } from '../../session/SemiontProvider';
import type { SemiontBrowser } from '../../session/semiont-browser';

interface FakeSession {
  expiresAt: Date | null;
  token$: BehaviorSubject<unknown>;
}

function buildBrowser(initialExpiresAt: Date | null): {
  browser: SemiontBrowser;
  setExpiresAt: (d: Date | null) => void;
} {
  const token$ = new BehaviorSubject<unknown>(
    initialExpiresAt ? 'token-placeholder' : null,
  );
  const session: FakeSession = { expiresAt: initialExpiresAt, token$ };
  const activeSession$ = new BehaviorSubject<FakeSession | null>(session);
  const setExpiresAt = (d: Date | null) => {
    session.expiresAt = d;
    // Push a UNIQUE value each time — useObservable's setState dedupes
    // by Object.is, so the token$ emission must be a new reference for
    // the hook to re-render and pick up the mutated `expiresAt`.
    // In production this happens naturally: every refresh produces a
    // different JWT string, so this is purely a test-fixture concern.
    token$.next(d ? `token-${d.getTime()}` : null);
  };
  return {
    browser: { activeSession$ } as unknown as SemiontBrowser,
    setExpiresAt,
  };
}

function makeWrapper(browser: SemiontBrowser) {
  return ({ children }: { children: ReactNode }) =>
    React.createElement(SemiontProvider, { browser }, children);
}

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
      const { browser } = buildBrowser(null);
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBeNull();
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should calculate time remaining correctly', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:30:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should set isExpiringSoon when less than 5 minutes remaining', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:04:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(4 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should not set isExpiringSoon when exactly 5 minutes remaining', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:05:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(5 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should return 0 when session is expired', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T11:00:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });
  });

  describe('Timer Updates', () => {
    it('should update timeRemaining every second', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:30:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);

      act(() => { vi.advanceTimersByTime(1000); });
      expect(result.current.timeRemaining).toBe(30 * 60 * 1000 - 1000);

      act(() => { vi.advanceTimersByTime(1000); });
      expect(result.current.timeRemaining).toBe(30 * 60 * 1000 - 2000);
    });

    it('should update isExpiringSoon when crossing 5 minute threshold', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:05:02Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.isExpiringSoon).toBe(false);

      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should stop updating isExpiringSoon when time expires', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:00:02Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(2000);
      expect(result.current.isExpiringSoon).toBe(true);

      act(() => { vi.advanceTimersByTime(3000); });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should continue updating until session expires', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:00:05Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      for (let i = 5; i >= 0; i--) {
        expect(result.current.timeRemaining).toBe(i * 1000);
        if (i > 0) {
          act(() => { vi.advanceTimersByTime(1000); });
        }
      }
    });
  });

  describe('Expiry Scenarios', () => {
    it('should handle long session (hours remaining)', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T16:00:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(4 * 60 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should handle session expiring in 1 minute', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:01:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(60 * 1000);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should handle session expiring in 30 seconds', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:00:30Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(30 * 1000);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should handle session already expired', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T11:59:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should handle session far in future', () => {
      const { browser } = buildBrowser(new Date('2024-01-02T12:00:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(24 * 60 * 60 * 1000);
      expect(result.current.isExpiringSoon).toBe(false);
    });
  });

  describe('Session Changes', () => {
    it('should update when expiresAt changes on the session', () => {
      const { browser, setExpiresAt } = buildBrowser(new Date('2024-01-01T12:30:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);

      act(() => { setExpiresAt(new Date('2024-01-01T12:15:00Z')); });

      expect(result.current.timeRemaining).toBe(15 * 60 * 1000);
    });

    it('should clear timer when expiresAt becomes null', () => {
      const { browser, setExpiresAt } = buildBrowser(new Date('2024-01-01T12:30:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);

      act(() => { setExpiresAt(null); });

      expect(result.current.timeRemaining).toBeNull();
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should start timer when expiresAt becomes available', () => {
      const { browser, setExpiresAt } = buildBrowser(null);
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBeNull();

      act(() => { setExpiresAt(new Date('2024-01-01T12:30:00Z')); });

      expect(result.current.timeRemaining).toBe(30 * 60 * 1000);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup interval on unmount', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:30:00Z'));
      const { result, unmount } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      const initialTime = result.current.timeRemaining;
      unmount();

      act(() => { vi.advanceTimersByTime(5000); });

      expect(initialTime).toBe(30 * 60 * 1000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle time exactly at 0', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:00:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });

    it('should handle millisecond precision', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T12:00:00.500Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(500);
      expect(result.current.isExpiringSoon).toBe(true);
    });

    it('should not show negative time remaining', () => {
      const { browser } = buildBrowser(new Date('2024-01-01T11:00:00Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBe(0);
      expect(result.current.timeRemaining).not.toBeLessThan(0);
    });

    it('should handle very large time remaining', () => {
      const { browser } = buildBrowser(new Date('2024-12-31T23:59:59Z'));
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current.timeRemaining).toBeGreaterThan(0);
      expect(result.current.isExpiringSoon).toBe(false);
    });
  });

  describe('Consistency', () => {
    it('should return consistent structure', () => {
      const { browser } = buildBrowser(null);
      const { result } = renderHook(() => useSessionExpiry(), {
        wrapper: makeWrapper(browser),
      });

      expect(result.current).toHaveProperty('timeRemaining');
      expect(result.current).toHaveProperty('isExpiringSoon');
    });
  });
});
