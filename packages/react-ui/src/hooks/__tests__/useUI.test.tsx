import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDropdown, useLoadingState, useLocalStorage } from '../useUI';

describe('useDropdown', () => {
  it('starts closed', () => {
    const { result } = renderHook(() => useDropdown());
    expect(result.current.isOpen).toBe(false);
  });

  it('toggle opens and closes', () => {
    const { result } = renderHook(() => useDropdown());
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(false);
  });

  it('open and close work directly', () => {
    const { result } = renderHook(() => useDropdown());
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it('closes on Escape key', () => {
    const { result } = renderHook(() => useDropdown());
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.isOpen).toBe(false);
  });

  it('does not close on click outside when ref is not attached', () => {
    // When dropdownRef.current is null, click-outside handler is a no-op
    const { result } = renderHook(() => useDropdown());
    act(() => result.current.open());

    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    // Still open because ref is null — the guard `dropdownRef.current &&` prevents close
    expect(result.current.isOpen).toBe(true);
  });
});

describe('useLoadingState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts not loading', () => {
    const { result } = renderHook(() => useLoadingState());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.showLoading).toBe(false);
  });

  it('startLoading sets both flags', () => {
    const { result } = renderHook(() => useLoadingState());
    act(() => result.current.startLoading());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.showLoading).toBe(true);
  });

  it('stopLoading clears isLoading immediately but delays showLoading', () => {
    const { result } = renderHook(() => useLoadingState(500));
    act(() => result.current.startLoading());
    act(() => result.current.stopLoading());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.showLoading).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.showLoading).toBe(false);
  });
});

describe('useLocalStorage', () => {
  beforeEach(() => localStorage.clear());

  it('returns initial value when nothing stored', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));
    expect(result.current[0]).toBe('default');
  });

  it('returns stored value when present', () => {
    localStorage.setItem('test-key', JSON.stringify('stored'));
    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));
    expect(result.current[0]).toBe('stored');
  });

  it('saves value to localStorage on set', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));
    act(() => result.current[1]('new-value'));
    expect(result.current[0]).toBe('new-value');
    expect(JSON.parse(localStorage.getItem('test-key')!)).toBe('new-value');
  });

  it('supports function updater', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 10));
    act(() => result.current[1]((prev) => prev + 5));
    expect(result.current[0]).toBe(15);
  });

  it('handles complex objects', () => {
    const { result } = renderHook(() => useLocalStorage('obj-key', { a: 1 }));
    act(() => result.current[1]({ a: 2, b: 3 } as any));
    expect(result.current[0]).toEqual({ a: 2, b: 3 });
  });
});
