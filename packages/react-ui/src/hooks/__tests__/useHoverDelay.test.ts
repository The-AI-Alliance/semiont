/**
 * Tests for useHoverDelay hook
 *
 * Validates the hover delay setting management:
 * - Initial value from localStorage
 * - Default value when no localStorage entry
 * - Setting new value
 * - localStorage persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHoverDelay } from '../useHoverDelay';
import { HOVER_DELAY_MS } from '../useBeckonFlow';

describe('useHoverDelay', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns default hover delay when no localStorage entry', () => {
    const { result } = renderHook(() => useHoverDelay());

    expect(result.current.hoverDelayMs).toBe(HOVER_DELAY_MS);
  });

  it('loads hover delay from localStorage on mount', () => {
    localStorage.setItem('hoverDelayMs', '300');

    const { result } = renderHook(() => useHoverDelay());

    expect(result.current.hoverDelayMs).toBe(300);
  });

  it('updates hover delay and persists to localStorage', () => {
    const { result } = renderHook(() => useHoverDelay());

    act(() => {
      result.current.setHoverDelayMs(500);
    });

    expect(result.current.hoverDelayMs).toBe(500);
    expect(localStorage.getItem('hoverDelayMs')).toBe('500');
  });

  it('provides stable setter function', () => {
    const { result, rerender } = renderHook(() => useHoverDelay());

    const firstSetter = result.current.setHoverDelayMs;

    rerender();

    const secondSetter = result.current.setHoverDelayMs;

    expect(firstSetter).toBe(secondSetter);
  });

  it('handles multiple updates correctly', () => {
    const { result } = renderHook(() => useHoverDelay());

    act(() => {
      result.current.setHoverDelayMs(200);
    });

    expect(result.current.hoverDelayMs).toBe(200);
    expect(localStorage.getItem('hoverDelayMs')).toBe('200');

    act(() => {
      result.current.setHoverDelayMs(400);
    });

    expect(result.current.hoverDelayMs).toBe(400);
    expect(localStorage.getItem('hoverDelayMs')).toBe('400');
  });

  it('handles zero delay', () => {
    const { result } = renderHook(() => useHoverDelay());

    act(() => {
      result.current.setHoverDelayMs(0);
    });

    expect(result.current.hoverDelayMs).toBe(0);
    expect(localStorage.getItem('hoverDelayMs')).toBe('0');
  });

  it('handles large delay values', () => {
    const { result } = renderHook(() => useHoverDelay());

    act(() => {
      result.current.setHoverDelayMs(5000);
    });

    expect(result.current.hoverDelayMs).toBe(5000);
    expect(localStorage.getItem('hoverDelayMs')).toBe('5000');
  });
});
