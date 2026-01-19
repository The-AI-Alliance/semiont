import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from '../useTheme';

describe('useTheme', () => {
  let localStorageMock: Record<string, string>;
  let matchMediaMock: any;

  beforeEach(() => {
    // Mock localStorage
    localStorageMock = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => localStorageMock[key] || null,
        setItem: (key: string, value: string) => {
          localStorageMock[key] = value;
        },
        removeItem: (key: string) => {
          delete localStorageMock[key];
        },
        clear: () => {
          localStorageMock = {};
        },
      },
      writable: true,
      configurable: true,
    });

    // Mock matchMedia
    matchMediaMock = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => matchMediaMock),
      writable: true,
      configurable: true,
    });

    // Mock document.documentElement
    document.documentElement.classList.remove('light', 'dark');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initialization', () => {
    it('should default to system theme', () => {
      const { result } = renderHook(() => useTheme());

      expect(result.current.theme).toBe('system');
    });

    it('should load theme from localStorage', () => {
      localStorageMock.theme = 'dark';

      const { result } = renderHook(() => useTheme());

      expect(result.current.theme).toBe('dark');
    });

    it('should apply light theme from localStorage', () => {
      localStorageMock.theme = 'light';

      renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('should apply dark theme from localStorage', () => {
      localStorageMock.theme = 'dark';

      renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('System Theme', () => {
    it('should apply light theme when system prefers light', () => {
      matchMediaMock.matches = false; // prefers light

      renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('should apply dark theme when system prefers dark', () => {
      matchMediaMock.matches = true; // prefers dark

      renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('should listen for system theme changes', () => {
      const { unmount } = renderHook(() => useTheme());

      expect(matchMediaMock.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );

      unmount();

      expect(matchMediaMock.removeEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
    });

    it('should always listen for system changes to track systemTheme', () => {
      localStorageMock.theme = 'dark';

      renderHook(() => useTheme());

      // Even when theme is set to 'dark', we still listen for system changes
      // to keep the systemTheme state up to date
      expect(matchMediaMock.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
    });

    it('should update theme when system preference changes', () => {
      matchMediaMock.matches = false; // Start with light

      const { rerender } = renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');

      // Simulate system theme change
      matchMediaMock.matches = true;
      const changeHandler = matchMediaMock.addEventListener.mock.calls[0][1];

      act(() => {
        changeHandler({ matches: true } as MediaQueryListEvent);
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('Theme Setter', () => {
    it('should update theme state', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('dark');
      });

      expect(result.current.theme).toBe('dark');
    });

    it('should persist theme to localStorage', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('dark');
      });

      expect(localStorageMock.theme).toBe('dark');
    });

    it('should apply dark theme to document', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('dark');
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('should apply light theme to document', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('light');
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('should switch from light to dark', () => {
      localStorageMock.theme = 'light';
      const { result } = renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');

      act(() => {
        result.current.setTheme('dark');
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('should switch from dark to light', () => {
      localStorageMock.theme = 'dark';
      const { result } = renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

      act(() => {
        result.current.setTheme('light');
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('should switch to system theme', () => {
      localStorageMock.theme = 'dark';
      matchMediaMock.matches = false; // System prefers light

      const { result } = renderHook(() => useTheme());

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

      act(() => {
        result.current.setTheme('system');
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(localStorageMock.theme).toBe('system');
    });
  });

  describe('Theme Removal and Reapplication', () => {
    it('should replace previous theme attribute when changing theme', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('light');
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');

      act(() => {
        result.current.setTheme('dark');
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('should always have listener for system changes', () => {
      const { result } = renderHook(() => useTheme());

      expect(matchMediaMock.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );

      act(() => {
        result.current.setTheme('dark');
      });

      // The listener persists - we always track system theme changes
      // Only cleanup happens on unmount
      expect(matchMediaMock.removeEventListener).not.toHaveBeenCalled();
    });

    it('should maintain system theme listener regardless of current theme', () => {
      localStorageMock.theme = 'dark';
      const { result } = renderHook(() => useTheme());

      // Listener is added on mount
      expect(matchMediaMock.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );

      act(() => {
        result.current.setTheme('system');
      });

      // Still have the same listener
      expect(matchMediaMock.addEventListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid theme changes', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('dark');
        result.current.setTheme('light');
        result.current.setTheme('system');
        result.current.setTheme('dark');
      });

      expect(result.current.theme).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(localStorageMock.theme).toBe('dark');
    });

    it('should handle empty localStorage', () => {
      delete localStorageMock.theme;

      const { result } = renderHook(() => useTheme());

      expect(result.current.theme).toBe('system');
    });

    it('should handle invalid localStorage value', () => {
      localStorageMock.theme = 'invalid' as any;

      const { result } = renderHook(() => useTheme());

      // Should fall back gracefully
      expect(result.current.theme).toBeTruthy();
    });
  });

  describe('Unmount Cleanup', () => {
    it('should cleanup listener on unmount when in system mode', () => {
      const { unmount } = renderHook(() => useTheme());

      expect(matchMediaMock.addEventListener).toHaveBeenCalled();

      unmount();

      expect(matchMediaMock.removeEventListener).toHaveBeenCalled();
    });

    it('should not throw on unmount when not in system mode', () => {
      localStorageMock.theme = 'dark';

      const { unmount } = renderHook(() => useTheme());

      expect(() => unmount()).not.toThrow();
    });
  });
});
