import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '@semiont/core';
import { createBrowseVM } from '../browse-vm';

describe('createBrowseVM', () => {
  let eventBus: EventBus;

  beforeEach(() => { eventBus = new EventBus(); });
  afterEach(() => { eventBus.destroy(); });

  it('starts with the given initial panel', () => {
    const vm = createBrowseVM(eventBus, { initialPanel: 'knowledge-base' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual(['knowledge-base']);
    vm.dispose();
  });

  it('defaults to null when no initial panel', () => {
    const vm = createBrowseVM(eventBus);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual([null]);
    vm.dispose();
  });

  it('toggles panel on browse:panel-toggle', () => {
    const vm = createBrowseVM(eventBus);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    eventBus.get('browse:panel-toggle').next({ panel: 'annotations' });
    expect(values).toEqual([null, 'annotations']);

    eventBus.get('browse:panel-toggle').next({ panel: 'annotations' });
    expect(values).toEqual([null, 'annotations', null]);
    vm.dispose();
  });

  it('switches panel when toggling a different one', () => {
    const vm = createBrowseVM(eventBus, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    eventBus.get('browse:panel-toggle').next({ panel: 'annotations' });
    expect(values).toEqual(['info', 'annotations']);
    vm.dispose();
  });

  it('opens panel on browse:panel-open', () => {
    const vm = createBrowseVM(eventBus);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    eventBus.get('browse:panel-open').next({ panel: 'history' });
    expect(values).toEqual([null, 'history']);
    vm.dispose();
  });

  it('sets scrollToAnnotationId on browse:panel-open with scrollTarget', () => {
    const vm = createBrowseVM(eventBus);
    const scrolls: (string | null)[] = [];
    vm.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    eventBus.get('browse:panel-open').next({ panel: 'annotations', scrollToAnnotationId: 'ann-42' });
    expect(scrolls).toEqual([null, 'ann-42']);
    vm.dispose();
  });

  it('maps all motivations to correct tab keys', () => {
    const vm = createBrowseVM(eventBus);
    const tabs: string[] = [];
    vm.panelInitialTab$.subscribe(v => { if (v) tabs.push(v.tab); });

    const cases: [string, string][] = [
      ['linking', 'reference'],
      ['commenting', 'comment'],
      ['tagging', 'tag'],
      ['highlighting', 'highlight'],
      ['assessing', 'assessment'],
    ];
    for (const [motivation, expected] of cases) {
      eventBus.get('browse:panel-open').next({ panel: 'annotations', motivation });
      expect(tabs[tabs.length - 1]).toBe(expected);
    }
    vm.dispose();
  });

  it('defaults to highlight tab for unknown motivation', () => {
    const vm = createBrowseVM(eventBus);
    const tabs: string[] = [];
    vm.panelInitialTab$.subscribe(v => { if (v) tabs.push(v.tab); });

    eventBus.get('browse:panel-open').next({ panel: 'annotations', motivation: 'unknown-thing' });
    expect(tabs[tabs.length - 1]).toBe('highlight');
    vm.dispose();
  });

  it('increments generation counter on each panel open with motivation', () => {
    const vm = createBrowseVM(eventBus);
    const generations: number[] = [];
    vm.panelInitialTab$.subscribe(v => { if (v) generations.push(v.generation); });

    eventBus.get('browse:panel-open').next({ panel: 'annotations', motivation: 'highlighting' });
    eventBus.get('browse:panel-open').next({ panel: 'annotations', motivation: 'highlighting' });
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBeGreaterThan(generations[0]);
    vm.dispose();
  });

  it('closes panel on browse:panel-close', () => {
    const vm = createBrowseVM(eventBus, { initialPanel: 'annotations' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    eventBus.get('browse:panel-close').next(undefined);
    expect(values).toEqual(['annotations', null]);
    vm.dispose();
  });

  it('clears scrollToAnnotationId on onScrollCompleted', () => {
    const vm = createBrowseVM(eventBus);
    const scrolls: (string | null)[] = [];
    vm.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    eventBus.get('browse:panel-open').next({ panel: 'annotations', scrollToAnnotationId: 'ann-1' });
    vm.onScrollCompleted();
    expect(scrolls).toEqual([null, 'ann-1', null]);
    vm.dispose();
  });

  it('calls onPanelChange callback', () => {
    const cb = vi.fn();
    const vm = createBrowseVM(eventBus, { initialPanel: 'info', onPanelChange: cb });
    expect(cb).toHaveBeenCalledWith('info');

    eventBus.get('browse:panel-toggle').next({ panel: 'info' });
    expect(cb).toHaveBeenCalledWith(null);
    vm.dispose();
  });

  it('openPanel command pushes to EventBus', () => {
    const vm = createBrowseVM(eventBus);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.openPanel('settings');
    expect(values).toEqual([null, 'settings']);
    vm.dispose();
  });

  it('closePanel command pushes to EventBus', () => {
    const vm = createBrowseVM(eventBus, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.closePanel();
    expect(values).toEqual(['info', null]);
    vm.dispose();
  });

  it('togglePanel command pushes to EventBus', () => {
    const vm = createBrowseVM(eventBus);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.togglePanel('annotations');
    vm.togglePanel('annotations');
    expect(values).toEqual([null, 'annotations', null]);
    vm.dispose();
  });

  it('stops responding after dispose', () => {
    const vm = createBrowseVM(eventBus);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.dispose();
    eventBus.get('browse:panel-open').next({ panel: 'info' });
    expect(values).toEqual([null]);
  });
});
