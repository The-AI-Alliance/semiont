/**
 * useBeckonFlow tests
 *
 * Tests hover state tracking, sparkle emission, and focus relay.
 * Also tests createHoverHandlers (plain factory) and useHoverEmitter (React hook).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useBeckonFlow, createHoverHandlers, useHoverEmitter, HOVER_DELAY_MS } from '../useBeckonFlow';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';

vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(function () {}),
  baseUrl: vi.fn(function (url: string) { return url; }),
  accessToken: vi.fn(function (t: string) { return t as any; }),
}));

const mockClient = {
  stores: { resources: { setTokenGetter: vi.fn() }, annotations: { setTokenGetter: vi.fn() } },
  flows: { attentionStream: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
};

vi.mocked(SemiontApiClient).mockImplementation(function () { return mockClient; });

const wrapper = ({ children }: { children: ReactNode }) =>
  React.createElement(
    EventBusProvider,
    null,
    React.createElement(
      AuthTokenProvider,
      { token: null },
      React.createElement(ApiClientProvider, { baseUrl: 'http://localhost:4000' }, children)
    )
  );

// ─── useBeckonFlow ────────────────────────────────────────────────────────────

describe('useBeckonFlow', () => {
  it('initializes with hoveredAnnotationId = null', () => {
    const { result } = renderHook(() => useBeckonFlow(), { wrapper });
    expect(result.current.hoveredAnnotationId).toBeNull();
  });

  it('updates hoveredAnnotationId on beckon:hover with an annotationId', async () => {
    const { result } = renderHook(
      () => ({ flow: useBeckonFlow(), bus: useEventBus() }),
      { wrapper }
    );

    act(() => {
      result.current.bus.get('beckon:hover').next({ annotationId: 'ann-1' });
    });

    await waitFor(() => {
      expect(result.current.flow.hoveredAnnotationId).toBe('ann-1');
    });
  });

  it('emits beckon:sparkle when hovering an annotation', async () => {
    const { result } = renderHook(
      () => ({ flow: useBeckonFlow(), bus: useEventBus() }),
      { wrapper }
    );

    const sparkleHandler = vi.fn();
    result.current.bus.get('beckon:sparkle').subscribe(sparkleHandler);

    act(() => {
      result.current.bus.get('beckon:hover').next({ annotationId: 'ann-2' });
    });

    await waitFor(() => {
      expect(sparkleHandler).toHaveBeenCalledWith({ annotationId: 'ann-2' });
    });
  });

  it('does not emit beckon:sparkle when annotationId is null (leave)', async () => {
    const { result } = renderHook(
      () => ({ flow: useBeckonFlow(), bus: useEventBus() }),
      { wrapper }
    );

    const sparkleHandler = vi.fn();
    result.current.bus.get('beckon:sparkle').subscribe(sparkleHandler);

    act(() => {
      result.current.bus.get('beckon:hover').next({ annotationId: null });
    });

    await waitFor(() => {
      expect(result.current.flow.hoveredAnnotationId).toBeNull();
    });

    expect(sparkleHandler).not.toHaveBeenCalled();
  });

  it('clears hoveredAnnotationId when annotationId is null', async () => {
    const { result } = renderHook(
      () => ({ flow: useBeckonFlow(), bus: useEventBus() }),
      { wrapper }
    );

    act(() => {
      result.current.bus.get('beckon:hover').next({ annotationId: 'ann-3' });
    });
    await waitFor(() => expect(result.current.flow.hoveredAnnotationId).toBe('ann-3'));

    act(() => {
      result.current.bus.get('beckon:hover').next({ annotationId: null });
    });
    await waitFor(() => expect(result.current.flow.hoveredAnnotationId).toBeNull());
  });

  it('emits beckon:focus on browse:click', async () => {
    const { result } = renderHook(
      () => ({ flow: useBeckonFlow(), bus: useEventBus() }),
      { wrapper }
    );

    const focusHandler = vi.fn();
    result.current.bus.get('beckon:focus').subscribe(focusHandler);

    act(() => {
      result.current.bus.get('browse:click').next({ annotationId: 'ann-focus' });
    });

    await waitFor(() => {
      expect(focusHandler).toHaveBeenCalledWith({ annotationId: 'ann-focus' });
    });
  });
});

// ─── createHoverHandlers ──────────────────────────────────────────────────────

describe('createHoverHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('emits hover after delay', () => {
    const emit = vi.fn();
    const { handleMouseEnter } = createHoverHandlers(emit, 100);

    handleMouseEnter('ann-1');
    expect(emit).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(100); });
    expect(emit).toHaveBeenCalledWith('ann-1');
  });

  it('emits null immediately on mouse leave', () => {
    const emit = vi.fn();
    const { handleMouseEnter, handleMouseLeave } = createHoverHandlers(emit, 100);

    handleMouseEnter('ann-1');
    act(() => { vi.advanceTimersByTime(100); });
    expect(emit).toHaveBeenCalledWith('ann-1');

    handleMouseLeave();
    expect(emit).toHaveBeenCalledWith(null);
  });

  it('cancels pending timer on mouse leave', () => {
    const emit = vi.fn();
    const { handleMouseEnter, handleMouseLeave } = createHoverHandlers(emit, 100);

    handleMouseEnter('ann-1');
    handleMouseLeave();
    act(() => { vi.advanceTimersByTime(100); });

    // Emit was never called because leave cancelled the timer
    expect(emit).not.toHaveBeenCalled();
  });

  it('suppresses redundant enters for the same annotation', () => {
    const emit = vi.fn();
    const { handleMouseEnter } = createHoverHandlers(emit, 100);

    handleMouseEnter('ann-1');
    act(() => { vi.advanceTimersByTime(100); });
    expect(emit).toHaveBeenCalledTimes(1);

    // Second enter for the same annotation should be suppressed
    handleMouseEnter('ann-1');
    act(() => { vi.advanceTimersByTime(100); });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('cleanup cancels the pending timer', () => {
    const emit = vi.fn();
    const { handleMouseEnter, cleanup } = createHoverHandlers(emit, 100);

    handleMouseEnter('ann-1');
    cleanup();
    act(() => { vi.advanceTimersByTime(100); });

    expect(emit).not.toHaveBeenCalled();
  });

  it('does not emit null on leave when nothing is hovering', () => {
    const emit = vi.fn();
    const { handleMouseLeave } = createHoverHandlers(emit, 100);

    handleMouseLeave();
    expect(emit).not.toHaveBeenCalled();
  });
});

// ─── useHoverEmitter ──────────────────────────────────────────────────────────

describe('useHoverEmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('emits beckon:hover after delay on mouse enter', async () => {
    const { result } = renderHook(
      () => ({ emitter: useHoverEmitter('ann-hover', 100), bus: useEventBus() }),
      { wrapper }
    );

    const hoverHandler = vi.fn();
    result.current.bus.get('beckon:hover').subscribe(hoverHandler);

    act(() => { result.current.emitter.onMouseEnter(); });
    expect(hoverHandler).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(100); });
    expect(hoverHandler).toHaveBeenCalledWith({ annotationId: 'ann-hover' });
  });

  it('emits null on mouse leave', async () => {
    const { result } = renderHook(
      () => ({ emitter: useHoverEmitter('ann-hover', 100), bus: useEventBus() }),
      { wrapper }
    );

    const hoverHandler = vi.fn();
    result.current.bus.get('beckon:hover').subscribe(hoverHandler);

    act(() => { result.current.emitter.onMouseEnter(); });
    act(() => { vi.advanceTimersByTime(100); });
    expect(hoverHandler).toHaveBeenCalledWith({ annotationId: 'ann-hover' });

    act(() => { result.current.emitter.onMouseLeave(); });
    expect(hoverHandler).toHaveBeenCalledWith({ annotationId: null });
  });

  it('cancels timer if mouse leaves before delay', () => {
    const { result } = renderHook(
      () => ({ emitter: useHoverEmitter('ann-hover', 100), bus: useEventBus() }),
      { wrapper }
    );

    const hoverHandler = vi.fn();
    result.current.bus.get('beckon:hover').subscribe(hoverHandler);

    act(() => { result.current.emitter.onMouseEnter(); });
    act(() => { result.current.emitter.onMouseLeave(); });
    act(() => { vi.advanceTimersByTime(100); });

    // No hover emitted (cancelled)
    expect(hoverHandler).not.toHaveBeenCalledWith({ annotationId: 'ann-hover' });
  });

  it('uses HOVER_DELAY_MS as default delay', () => {
    expect(HOVER_DELAY_MS).toBeGreaterThan(0);
    // Just verify the constant is exported and has a sensible value
    expect(HOVER_DELAY_MS).toBe(150);
  });
});
