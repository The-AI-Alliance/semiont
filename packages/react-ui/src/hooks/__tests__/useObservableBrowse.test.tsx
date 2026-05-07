import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { EventBus } from '@semiont/core';
import { useObservableRouter, useObservableExternalNavigation } from '../useObservableBrowse';
import { createTestSemiontWrapper } from '../../test-utils';

function makeWrapper(): { Wrapper: React.ComponentType<{ children: React.ReactNode }>; eventBus: EventBus } {
  // useObservableRouter/ExternalNavigation emit nav:* on the app-scoped
  // (SemiontBrowser) bus. Return that bus as `eventBus` so the existing
  // test bodies keep working without rewiring each assertion.
  const { SemiontWrapper, shellBus } = createTestSemiontWrapper();
  const Wrapper = ({ children }: { children: React.ReactNode }) => <SemiontWrapper>{children}</SemiontWrapper>;
  return { Wrapper, eventBus: shellBus };
}

describe('useObservableRouter', () => {
  beforeEach(() => {
  });

  it('wraps push and emits nav:push event', () => {
    const basePush = vi.fn();
    const baseRouter = { push: basePush };

    const { Wrapper, eventBus } = makeWrapper();
    const { result } = renderHook(() => useObservableRouter(baseRouter), { wrapper: Wrapper });

    const events: any[] = [];
    eventBus.get('nav:push').subscribe((e: any) => events.push(e));

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

    const { Wrapper, eventBus } = makeWrapper();
    const { result } = renderHook(() => useObservableRouter(baseRouter), { wrapper: Wrapper });

    const events: any[] = [];
    eventBus.get('nav:push').subscribe((e: any) => events.push(e));

    act(() => {
      result.current.replace!('/replaced', { reason: 'nav' });
    });

    expect(baseReplace).toHaveBeenCalledWith('/replaced');
    expect(events[0]).toEqual({ path: '/replaced', reason: 'replace:nav' });
  });

  it('does not expose replace when base router lacks it', () => {
    const baseRouter = { push: vi.fn() };
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useObservableRouter(baseRouter), { wrapper: Wrapper });

    expect(result.current.replace).toBeUndefined();
  });

  it('passes through other router properties', () => {
    const baseRouter = { push: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useObservableRouter(baseRouter), { wrapper: Wrapper });

    expect(result.current.back).toBe(baseRouter.back);
    expect(result.current.prefetch).toBe(baseRouter.prefetch);
  });
});

describe('useObservableExternalNavigation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits nav:external event with url and metadata', () => {
    const { Wrapper, eventBus } = makeWrapper();
    const { result } = renderHook(() => useObservableExternalNavigation(), { wrapper: Wrapper });

    const events: any[] = [];
    eventBus.get('nav:external').subscribe((e: any) => events.push(e));

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
    const { Wrapper, eventBus } = makeWrapper();
    const { result } = renderHook(() => useObservableExternalNavigation(), { wrapper: Wrapper });

    // Subscribe and cancel the fallback
    eventBus.get('nav:external').subscribe((e: any) => {
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
