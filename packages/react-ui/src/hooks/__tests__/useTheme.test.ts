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

      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('should apply dark theme from localStorage', () => {
      localStorageMock.theme = 'dark';

      renderHook(() => useTheme());

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
    });
  });

  describe('System Theme', () => {
    it('should apply light theme when system prefers light', () => {
      matchMediaMock.matches = false; // prefers light

      renderHook(() => useTheme());

      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('should apply dark theme when system prefers dark', () => {
      matchMediaMock.matches = true; // prefers dark

      renderHook(() => useTheme());

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
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

    it('should not listen for system changes when theme is not system', () => {
      localStorageMock.theme = 'dark';

      renderHook(() => useTheme());

      expect(matchMediaMock.addEventListener).not.toHaveBeenCalled();
    });

    it('should update theme when system preference changes', () => {
      matchMediaMock.matches = false; // Start with light

      const { rerender } = renderHook(() => useTheme());

      expect(document.documentElement.classList.contains('light')).toBe(true);

      // Simulate system theme change
      matchMediaMock.matches = true;
      const changeHandler = matchMediaMock.addEventListener.mock.calls[0][1];

      act(() => {
        changeHandler();
      });

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
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

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
    });

    it('should apply light theme to document', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('light');
      });

      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('should switch from light to dark', () => {
      localStorageMock.theme = 'light';
      const { result } = renderHook(() => useTheme());

      expect(document.documentElement.classList.contains('light')).toBe(true);

      act(() => {
        result.current.setTheme('dark');
      });

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
    });

    it('should switch from dark to light', () => {
      localStorageMock.theme = 'dark';
      const { result } = renderHook(() => useTheme());

      expect(document.documentElement.classList.contains('dark')).toBe(true);

      act(() => {
        result.current.setTheme('light');
      });

      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('should switch to system theme', () => {
      localStorageMock.theme = 'dark';
      matchMediaMock.matches = false; // System prefers light

      const { result } = renderHook(() => useTheme());

      expect(document.documentElement.classList.contains('dark')).toBe(true);

      act(() => {
        result.current.setTheme('system');
      });

      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(localStorageMock.theme).toBe('system');
    });
  });

  describe('Theme Removal and Reapplication', () => {
    it('should remove previous theme class when changing theme', () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setTheme('light');
      });

      expect(document.documentElement.classList.contains('light')).toBe(true);

      act(() => {
        result.current.setTheme('dark');
      });

      expect(document.documentElement.classList.contains('light')).toBe(false);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('should clean up listeners when switching from system to fixed theme', () => {
      const { result } = renderHook(() => useTheme());

      expect(matchMediaMock.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );

      act(() => {
        result.current.setTheme('dark');
      });

      // Should have cleaned up the listener when theme changed from system
      expect(matchMediaMock.removeEventListener).toHaveBeenCalled();
    });

    it('should add listeners when switching to system theme', () => {
      localStorageMock.theme = 'dark';
      const { result } = renderHook(() => useTheme());

      expect(matchMediaMock.addEventListener).not.toHaveBeenCalled();

      act(() => {
        result.current.setTheme('system');
      });

      expect(matchMediaMock.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
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
      expect(document.documentElement.classList.contains('dark')).toBe(true);
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
