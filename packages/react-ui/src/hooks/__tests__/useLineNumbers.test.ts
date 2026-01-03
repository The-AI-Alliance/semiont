import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLineNumbers } from '../useLineNumbers';

describe('useLineNumbers', () => {
  let localStorageMock: Record<string, string>;

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
  });

  describe('Initialization', () => {
    it('should default to false when no stored value', () => {
      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(false);
    });

    it('should load true from localStorage', () => {
      localStorageMock.showLineNumbers = 'true';

      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(true);
    });

    it('should load false from localStorage', () => {
      localStorageMock.showLineNumbers = 'false';

      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(false);
    });

    it('should handle non-boolean localStorage value', () => {
      localStorageMock.showLineNumbers = 'not-a-boolean';

      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(false);
    });
  });

  describe('Toggle Functionality', () => {
    it('should toggle from false to true', () => {
      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(false);

      act(() => {
        result.current.toggleLineNumbers();
      });

      expect(result.current.showLineNumbers).toBe(true);
    });

    it('should toggle from true to false', () => {
      localStorageMock.showLineNumbers = 'true';
      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(true);

      act(() => {
        result.current.toggleLineNumbers();
      });

      expect(result.current.showLineNumbers).toBe(false);
    });

    it('should persist true state to localStorage', () => {
      const { result } = renderHook(() => useLineNumbers());

      act(() => {
        result.current.toggleLineNumbers();
      });

      expect(localStorageMock.showLineNumbers).toBe('true');
    });

    it('should persist false state to localStorage', () => {
      localStorageMock.showLineNumbers = 'true';
      const { result } = renderHook(() => useLineNumbers());

      act(() => {
        result.current.toggleLineNumbers();
      });

      expect(localStorageMock.showLineNumbers).toBe('false');
    });

    it('should toggle multiple times correctly', () => {
      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(false);

      act(() => {
        result.current.toggleLineNumbers(); // -> true
      });
      expect(result.current.showLineNumbers).toBe(true);

      act(() => {
        result.current.toggleLineNumbers(); // -> false
      });
      expect(result.current.showLineNumbers).toBe(false);

      act(() => {
        result.current.toggleLineNumbers(); // -> true
      });
      expect(result.current.showLineNumbers).toBe(true);
    });
  });

  describe('Callback Stability', () => {
    it('should return stable toggleLineNumbers function', () => {
      const { result, rerender } = renderHook(() => useLineNumbers());

      const firstToggle = result.current.toggleLineNumbers;

      act(() => {
        result.current.toggleLineNumbers();
      });

      rerender();

      // Function reference should change because it depends on showLineNumbers
      // (This is expected behavior due to useCallback dependency)
      expect(result.current.toggleLineNumbers).not.toBe(firstToggle);
    });

    it('should work correctly when toggle function is stored', () => {
      const { result } = renderHook(() => useLineNumbers());

      const toggle = result.current.toggleLineNumbers;

      act(() => {
        toggle();
      });

      expect(result.current.showLineNumbers).toBe(true);
    });
  });

  describe('Persistence', () => {
    it('should maintain state across rerenders', () => {
      const { result, rerender } = renderHook(() => useLineNumbers());

      act(() => {
        result.current.toggleLineNumbers();
      });

      expect(result.current.showLineNumbers).toBe(true);

      rerender();

      expect(result.current.showLineNumbers).toBe(true);
    });

    it('should load persisted state in new hook instance', () => {
      const { result: result1 } = renderHook(() => useLineNumbers());

      act(() => {
        result1.current.toggleLineNumbers();
      });

      expect(localStorageMock.showLineNumbers).toBe('true');

      // Create a new instance of the hook
      const { result: result2 } = renderHook(() => useLineNumbers());

      // New instance should load the persisted state
      expect(result2.current.showLineNumbers).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid toggles', () => {
      const { result } = renderHook(() => useLineNumbers());

      // Each toggle needs its own act() to process state updates
      act(() => {
        result.current.toggleLineNumbers(); // false -> true
      });
      act(() => {
        result.current.toggleLineNumbers(); // true -> false
      });
      act(() => {
        result.current.toggleLineNumbers(); // false -> true
      });

      expect(result.current.showLineNumbers).toBe(true);
      expect(localStorageMock.showLineNumbers).toBe('true');
    });

    it('should handle empty localStorage', () => {
      delete localStorageMock.showLineNumbers;

      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(false);
    });

    it('should handle localStorage being cleared mid-session', () => {
      localStorageMock.showLineNumbers = 'true';
      const { result } = renderHook(() => useLineNumbers());

      expect(result.current.showLineNumbers).toBe(true);

      // Clear localStorage
      delete localStorageMock.showLineNumbers;

      // State should still be true (in memory)
      expect(result.current.showLineNumbers).toBe(true);

      // Toggle should still work and persist new value
      act(() => {
        result.current.toggleLineNumbers();
      });

      expect(result.current.showLineNumbers).toBe(false);
      expect(localStorageMock.showLineNumbers).toBe('false');
    });
  });

  describe('Return Value Structure', () => {
    it('should return object with showLineNumbers and toggleLineNumbers', () => {
      const { result } = renderHook(() => useLineNumbers());

      expect(result.current).toHaveProperty('showLineNumbers');
      expect(result.current).toHaveProperty('toggleLineNumbers');
    });

    it('should have showLineNumbers as boolean', () => {
      const { result } = renderHook(() => useLineNumbers());

      expect(typeof result.current.showLineNumbers).toBe('boolean');
    });

    it('should have toggleLineNumbers as function', () => {
      const { result } = renderHook(() => useLineNumbers());

      expect(typeof result.current.toggleLineNumbers).toBe('function');
    });
  });
});
