/**
 * Tests for usePanelWidth hook
 *
 * Validates the panel width management:
 * - Default width initialization
 * - localStorage persistence
 * - Min/max constraints
 * - Custom configuration options
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePanelWidth } from '../usePanelWidth';

describe('usePanelWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns default width when no localStorage entry', () => {
    const { result } = renderHook(() => usePanelWidth());

    expect(result.current.width).toBe(384); // Default 24rem
    expect(result.current.minWidth).toBe(256); // Default 16rem
    expect(result.current.maxWidth).toBe(800); // Default 50rem
  });

  it('loads width from localStorage on mount', async () => {
    localStorage.setItem('semiont-panel-width', '500');

    const { result } = renderHook(() => usePanelWidth());

    await waitFor(() => {
      expect(result.current.width).toBe(500);
    });
  });

  it('updates width and persists to localStorage', async () => {
    const { result } = renderHook(() => usePanelWidth());

    act(() => {
      result.current.setWidth(600);
    });

    expect(result.current.width).toBe(600);

    await waitFor(() => {
      expect(localStorage.getItem('semiont-panel-width')).toBe('600');
    });
  });

  it('enforces minimum width constraint', async () => {
    const { result } = renderHook(() => usePanelWidth());

    act(() => {
      result.current.setWidth(100); // Below minWidth (256)
    });

    expect(result.current.width).toBe(256);

    await waitFor(() => {
      expect(localStorage.getItem('semiont-panel-width')).toBe('256');
    });
  });

  it('enforces maximum width constraint', async () => {
    const { result } = renderHook(() => usePanelWidth());

    act(() => {
      result.current.setWidth(1000); // Above maxWidth (800)
    });

    expect(result.current.width).toBe(800);

    await waitFor(() => {
      expect(localStorage.getItem('semiont-panel-width')).toBe('800');
    });
  });

  it('constrains localStorage value on mount', async () => {
    localStorage.setItem('semiont-panel-width', '1500'); // Above maxWidth

    const { result } = renderHook(() => usePanelWidth());

    await waitFor(() => {
      expect(result.current.width).toBe(800); // Constrained to maxWidth
    });
  });

  it('uses custom default width', () => {
    const { result } = renderHook(() => usePanelWidth({ defaultWidth: 450 }));

    expect(result.current.width).toBe(450);
  });

  it('uses custom min/max constraints', async () => {
    const { result } = renderHook(() =>
      usePanelWidth({ minWidth: 300, maxWidth: 600 })
    );

    expect(result.current.minWidth).toBe(300);
    expect(result.current.maxWidth).toBe(600);

    // Test min constraint
    act(() => {
      result.current.setWidth(200);
    });

    expect(result.current.width).toBe(300);

    // Test max constraint
    act(() => {
      result.current.setWidth(700);
    });

    expect(result.current.width).toBe(600);
  });

  it('uses custom storage key', async () => {
    const customKey = 'custom-panel-width';
    localStorage.setItem(customKey, '450');

    const { result } = renderHook(() =>
      usePanelWidth({ storageKey: customKey })
    );

    await waitFor(() => {
      expect(result.current.width).toBe(450);
    });

    act(() => {
      result.current.setWidth(500);
    });

    await waitFor(() => {
      expect(localStorage.getItem(customKey)).toBe('500');
    });
  });

  it('handles multiple updates correctly', async () => {
    const { result } = renderHook(() => usePanelWidth());

    act(() => {
      result.current.setWidth(400);
    });

    expect(result.current.width).toBe(400);

    act(() => {
      result.current.setWidth(500);
    });

    expect(result.current.width).toBe(500);

    await waitFor(() => {
      expect(localStorage.getItem('semiont-panel-width')).toBe('500');
    });
  });

  it('does not persist initial mount from localStorage', async () => {
    localStorage.setItem('semiont-panel-width', '450');

    const { result } = renderHook(() => usePanelWidth());

    await waitFor(() => {
      expect(result.current.width).toBe(450);
    });

    // localStorage should still have the original value (not re-persisted)
    expect(localStorage.getItem('semiont-panel-width')).toBe('450');
  });
});
