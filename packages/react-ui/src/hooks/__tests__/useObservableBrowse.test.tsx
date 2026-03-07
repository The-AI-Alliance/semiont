import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useObservableRouter, useObservableExternalNavigation } from '../useObservableBrowse';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { resetEventBusForTesting } from '../../contexts/EventBusContext';

// Wrapper that provides EventBus context
function Wrapper({ children }: { children: React.ReactNode }) {
  return <EventBusProvider>{children}</EventBusProvider>;
}

describe('useObservableRouter', () => {
  beforeEach(() => {
    resetEventBusForTesting();
  });

  it('wraps push and emits browse:router-push event', () => {
    const basePush = vi.fn();
    const baseRouter = { push: basePush };

    let eventBus: any;
    const { result } = renderHook(() => {
      eventBus = useEventBus();
      return useObservableRouter(baseRouter);
    }, { wrapper: Wrapper });

    const events: any[] = [];
    eventBus.get('browse:router-push').subscribe((e: any) => events.push(e));

    act(() => {
      result.current.push('/test-path', { reason: 'test' });
    });

    expect(basePush).toHaveBeenCalledWith('/test-path');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ path: '/test-path', reason: 'test' });
  });

  it('wraps replace when available', () => {
    const baseReplace = vi.fn();
    const baseRouter = { push: vi.fn(), replace: baseReplace };

    let eventBus: any;
    const { result } = renderHook(() => {
      eventBus = useEventBus();
      return useObservableRouter(baseRouter);
    }, { wrapper: Wrapper });

    const events: any[] = [];
    eventBus.get('browse:router-push').subscribe((e: any) => events.push(e));

    act(() => {
      result.current.replace!('/replaced', { reason: 'nav' });
    });

    expect(baseReplace).toHaveBeenCalledWith('/replaced');
    expect(events[0]).toEqual({ path: '/replaced', reason: 'replace:nav' });
  });

  it('does not expose replace when base router lacks it', () => {
    const baseRouter = { push: vi.fn() };

    const { result } = renderHook(() => {
      return useObservableRouter(baseRouter);
    }, { wrapper: Wrapper });

    expect(result.current.replace).toBeUndefined();
  });

  it('passes through other router properties', () => {
    const baseRouter = { push: vi.fn(), back: vi.fn(), prefetch: vi.fn() };

    const { result } = renderHook(() => {
      return useObservableRouter(baseRouter);
    }, { wrapper: Wrapper });

    expect(result.current.back).toBe(baseRouter.back);
    expect(result.current.prefetch).toBe(baseRouter.prefetch);
  });
});

describe('useObservableExternalNavigation', () => {
  beforeEach(() => {
    resetEventBusForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits browse:external-navigate event with url and metadata', () => {
    let eventBus: any;
    const { result } = renderHook(() => {
      eventBus = useEventBus();
      return useObservableExternalNavigation();
    }, { wrapper: Wrapper });

    const events: any[] = [];
    eventBus.get('browse:external-navigate').subscribe((e: any) => events.push(e));

    act(() => {
      result.current('/some/url', { resourceId: 'res-123' });
    });

    expect(events).toHaveLength(1);
    expect(events[0].url).toBe('/some/url');
    expect(events[0].resourceId).toBe('res-123');
    expect(typeof events[0].cancelFallback).toBe('function');

    // Cancel fallback to prevent window.location change
    events[0].cancelFallback();
    vi.advanceTimersByTime(100);
  });

  it('provides cancelFallback that prevents window.location fallback', () => {
    let eventBus: any;
    const { result } = renderHook(() => {
      eventBus = useEventBus();
      return useObservableExternalNavigation();
    }, { wrapper: Wrapper });

    // Subscribe and cancel the fallback
    eventBus.get('browse:external-navigate').subscribe((e: any) => {
      e.cancelFallback();
    });

    const originalHref = window.location.href;

    act(() => {
      result.current('/new-url');
    });

    // Advance past the fallback timer
    vi.advanceTimersByTime(100);

    // Location should not have changed because we cancelled
    expect(window.location.href).toBe(originalHref);
  });
});
