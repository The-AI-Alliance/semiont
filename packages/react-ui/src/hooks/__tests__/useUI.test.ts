import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useDropdown,
  useLoadingState,
} from '../useUI';

// Following MSW v2 + Vitest + ESM strategy established in the codebase
describe('useUI Hooks', () => {
  describe('useDropdown', () => {
    let addEventListenerSpy: any;
    let removeEventListenerSpy: any;

    beforeEach(() => {
      addEventListenerSpy = vi.spyOn(document, 'addEventListener');
      removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
    });

    afterEach(() => {
      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();
    });

    describe('Initial State', () => {
      it('should initialize with closed state', () => {
        const { result } = renderHook(() => useDropdown());

        expect(result.current.isOpen).toBe(false);
        expect(result.current.dropdownRef).toBeDefined();
        expect(typeof result.current.toggle).toBe('function');
        expect(typeof result.current.open).toBe('function');
        expect(typeof result.current.close).toBe('function');
      });
    });

    describe('Toggle Operations', () => {
      it('should toggle open/closed state', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.toggle();
        });
        expect(result.current.isOpen).toBe(true);

        act(() => {
          result.current.toggle();
        });
        expect(result.current.isOpen).toBe(false);
      });

      it('should open dropdown', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });
        expect(result.current.isOpen).toBe(true);
      });

      it('should close dropdown', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });
        expect(result.current.isOpen).toBe(true);

        act(() => {
          result.current.close();
        });
        expect(result.current.isOpen).toBe(false);
      });
    });

    describe('Event Listeners', () => {
      it('should add event listeners when open', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });

        expect(addEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
        expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      });

      it('should remove event listeners when closed', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });

        act(() => {
          result.current.close();
        });

        expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
        expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      });

      it('should close on Escape key press', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });
        expect(result.current.isOpen).toBe(true);

        act(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(result.current.isOpen).toBe(false);
      });

      it('should not close on non-Escape key press', () => {
        const { result } = renderHook(() => useDropdown());

        act(() => {
          result.current.open();
        });

        act(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        });
        expect(result.current.isOpen).toBe(true);
      });
    });
  });

  describe('useLoadingState', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('Initial State', () => {
      it('should initialize with loading false', () => {
        const { result } = renderHook(() => useLoadingState());

        expect(result.current.isLoading).toBe(false);
        expect(result.current.showLoading).toBe(false);
      });

      it('should accept custom minimum loading time', () => {
        const { result } = renderHook(() => useLoadingState(1000));

        act(() => {
          result.current.startLoading();
        });

        expect(result.current.isLoading).toBe(true);
      });
    });

    describe('Loading State Management', () => {
      it('should show loading when started', () => {
        const { result } = renderHook(() => useLoadingState());

        act(() => {
          result.current.startLoading();
        });

        expect(result.current.isLoading).toBe(true);
        expect(result.current.showLoading).toBe(true);
      });

      it('should hide isLoading immediately when stopped', () => {
        const { result } = renderHook(() => useLoadingState());

        act(() => {
          result.current.startLoading();
        });

        act(() => {
          result.current.stopLoading();
        });

        expect(result.current.isLoading).toBe(false);
        // showLoading stays true until min time passes
        expect(result.current.showLoading).toBe(true);
      });

      it('should hide showLoading after minimum loading time', () => {
        const { result } = renderHook(() => useLoadingState(500));

        act(() => {
          result.current.startLoading();
        });

        act(() => {
          result.current.stopLoading();
        });

        act(() => {
          vi.advanceTimersByTime(500);
        });

        expect(result.current.showLoading).toBe(false);
      });

      it('should not hide showLoading before minimum loading time', () => {
        const { result } = renderHook(() => useLoadingState(500));

        act(() => {
          result.current.startLoading();
        });

        act(() => {
          result.current.stopLoading();
        });

        act(() => {
          vi.advanceTimersByTime(499);
        });

        expect(result.current.showLoading).toBe(true);
      });
    });

    describe('Cleanup', () => {
      it('should clean up timeout on unmount', () => {
        const { result, unmount } = renderHook(() => useLoadingState());

        act(() => {
          result.current.startLoading();
          result.current.stopLoading();
        });

        unmount();

        act(() => {
          vi.advanceTimersByTime(500);
        });
        // Should not cause errors after unmount
      });
    });
  });
});
