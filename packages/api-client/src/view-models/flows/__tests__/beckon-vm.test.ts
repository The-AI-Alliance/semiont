import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { annotationId } from '@semiont/core';
import { createBeckonVM, createHoverHandlers, HOVER_DELAY_MS } from '../beckon-vm';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';

describe('createBeckonVM', () => {
  let tc: TestClient;

  beforeEach(() => {
    tc = makeTestClient();
  });

  afterEach(() => {
    tc.bus.destroy();
  });

  it('starts with hoveredAnnotationId = null', () => {
    const vm = createBeckonVM(tc.client);
    const values: (string | null)[] = [];
    vm.hoveredAnnotationId$.subscribe(v => values.push(v));
    expect(values).toEqual([null]);
    vm.dispose();
  });

  it('updates hoveredAnnotationId on beckon:hover', () => {
    const vm = createBeckonVM(tc.client);
    const values: (string | null)[] = [];
    vm.hoveredAnnotationId$.subscribe(v => values.push(v));

    tc.bus.get('beckon:hover').next({ annotationId: 'ann-1' });
    expect(values).toEqual([null, 'ann-1']);
    vm.dispose();
  });

  it('clears hoveredAnnotationId on null hover', () => {
    const vm = createBeckonVM(tc.client);
    const values: (string | null)[] = [];
    vm.hoveredAnnotationId$.subscribe(v => values.push(v));

    tc.bus.get('beckon:hover').next({ annotationId: 'ann-1' });
    tc.bus.get('beckon:hover').next({ annotationId: null });
    expect(values).toEqual([null, 'ann-1', null]);
    vm.dispose();
  });

  it('emits beckon:sparkle on non-null hover', () => {
    const vm = createBeckonVM(tc.client);
    const sparkles: string[] = [];
    tc.bus.get('beckon:sparkle').subscribe(e => sparkles.push(e.annotationId));

    tc.bus.get('beckon:hover').next({ annotationId: 'ann-2' });
    expect(sparkles).toEqual(['ann-2']);
    vm.dispose();
  });

  it('does not emit beckon:sparkle on null hover', () => {
    const vm = createBeckonVM(tc.client);
    const sparkles: string[] = [];
    tc.bus.get('beckon:sparkle').subscribe(e => sparkles.push(e.annotationId));

    tc.bus.get('beckon:hover').next({ annotationId: null });
    expect(sparkles).toEqual([]);
    vm.dispose();
  });

  it('relays browse:click to beckon:focus', () => {
    const vm = createBeckonVM(tc.client);
    const focuses: string[] = [];
    tc.bus.get('beckon:focus').subscribe(e => focuses.push(e.annotationId!));

    tc.bus.get('browse:click').next({ annotationId: 'ann-click', motivation: 'highlighting' });
    expect(focuses).toEqual(['ann-click']);
    vm.dispose();
  });

  it('browse:click does not change hoveredAnnotationId', () => {
    const vm = createBeckonVM(tc.client);
    const values: (string | null)[] = [];
    vm.hoveredAnnotationId$.subscribe(v => values.push(v));

    tc.bus.get('beckon:hover').next({ annotationId: 'ann-hovered' });
    tc.bus.get('browse:click').next({ annotationId: 'ann-clicked', motivation: 'highlighting' });
    expect(values).toEqual([null, 'ann-hovered']);
    vm.dispose();
  });

  it('hover() command pushes to EventBus', () => {
    const vm = createBeckonVM(tc.client);
    const values: (string | null)[] = [];
    vm.hoveredAnnotationId$.subscribe(v => values.push(v));

    vm.hover(annotationId('ann-cmd'));
    expect(values).toEqual([null, 'ann-cmd']);
    vm.dispose();
  });

  it('focus() command pushes to EventBus', () => {
    const vm = createBeckonVM(tc.client);
    const focuses: string[] = [];
    tc.bus.get('beckon:focus').subscribe(e => focuses.push(e.annotationId!));

    vm.focus(annotationId('ann-focus'));
    expect(focuses).toEqual(['ann-focus']);
    vm.dispose();
  });

  it('sparkle() command pushes to EventBus', () => {
    const vm = createBeckonVM(tc.client);
    const sparkles: string[] = [];
    tc.bus.get('beckon:sparkle').subscribe(e => sparkles.push(e.annotationId));

    vm.sparkle(annotationId('ann-sparkle'));
    expect(sparkles).toEqual(['ann-sparkle']);
    vm.dispose();
  });

  it('stops responding after dispose', () => {
    const vm = createBeckonVM(tc.client);
    const values: (string | null)[] = [];
    vm.hoveredAnnotationId$.subscribe(v => values.push(v));

    vm.dispose();
    tc.bus.get('beckon:hover').next({ annotationId: 'ghost' });
    expect(values).toEqual([null]); // only the initial null, no 'ghost'
  });
});

describe('createHoverHandlers', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits hover after delay', () => {
    const emit = vi.fn();
    const { handleMouseEnter } = createHoverHandlers(emit, 100);
    handleMouseEnter(annotationId('ann-1'));
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledWith('ann-1');
  });

  it('emits null immediately on mouse leave', () => {
    const emit = vi.fn();
    const { handleMouseEnter, handleMouseLeave } = createHoverHandlers(emit, 100);
    handleMouseEnter(annotationId('ann-1'));
    vi.advanceTimersByTime(100);
    handleMouseLeave();
    expect(emit).toHaveBeenCalledWith(null);
  });

  it('cancels pending timer on mouse leave', () => {
    const emit = vi.fn();
    const { handleMouseEnter, handleMouseLeave } = createHoverHandlers(emit, 100);
    handleMouseEnter(annotationId('ann-1'));
    handleMouseLeave();
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
  });

  it('suppresses redundant enters for the same annotation', () => {
    const emit = vi.fn();
    const { handleMouseEnter } = createHoverHandlers(emit, 100);
    handleMouseEnter(annotationId('ann-1'));
    vi.advanceTimersByTime(100);
    handleMouseEnter(annotationId('ann-1'));
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('cleanup cancels the pending timer', () => {
    const emit = vi.fn();
    const { handleMouseEnter, cleanup } = createHoverHandlers(emit, 100);
    handleMouseEnter(annotationId('ann-1'));
    cleanup();
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not emit null on leave when nothing is hovering', () => {
    const emit = vi.fn();
    const { handleMouseLeave } = createHoverHandlers(emit, 100);
    handleMouseLeave();
    expect(emit).not.toHaveBeenCalled();
  });

  it('exports HOVER_DELAY_MS as 150', () => {
    expect(HOVER_DELAY_MS).toBe(150);
  });
});
