import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBrowseVM } from '../browse-vm';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';

describe('createBrowseVM', () => {
  let tc: TestClient;

  beforeEach(() => { tc = makeTestClient(); });
  afterEach(() => { tc.bus.destroy(); });

  it('starts with the given initial panel', () => {
    const vm = createBrowseVM(tc.client, { initialPanel: 'knowledge-base' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual(['knowledge-base']);
    vm.dispose();
  });

  it('defaults to null when no initial panel', () => {
    const vm = createBrowseVM(tc.client);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual([null]);
    vm.dispose();
  });

  it('toggles panel on browse:panel-toggle', () => {
    const vm = createBrowseVM(tc.client);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    tc.client.emit('browse:panel-toggle', { panel: 'annotations' });
    expect(values).toEqual([null, 'annotations']);

    tc.client.emit('browse:panel-toggle', { panel: 'annotations' });
    expect(values).toEqual([null, 'annotations', null]);
    vm.dispose();
  });

  it('switches panel when toggling a different one', () => {
    const vm = createBrowseVM(tc.client, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    tc.client.emit('browse:panel-toggle', { panel: 'annotations' });
    expect(values).toEqual(['info', 'annotations']);
    vm.dispose();
  });

  it('opens panel on browse:panel-open', () => {
    const vm = createBrowseVM(tc.client);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    tc.client.emit('browse:panel-open', { panel: 'history' });
    expect(values).toEqual([null, 'history']);
    vm.dispose();
  });

  it('sets scrollToAnnotationId on browse:panel-open with scrollTarget', () => {
    const vm = createBrowseVM(tc.client);
    const scrolls: (string | null)[] = [];
    vm.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    tc.client.emit('browse:panel-open', { panel: 'annotations', scrollToAnnotationId: 'ann-42' });
    expect(scrolls).toEqual([null, 'ann-42']);
    vm.dispose();
  });

  it('maps all motivations to correct tab keys', () => {
    const vm = createBrowseVM(tc.client);
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
      tc.client.emit('browse:panel-open', { panel: 'annotations', motivation });
      expect(tabs[tabs.length - 1]).toBe(expected);
    }
    vm.dispose();
  });

  it('defaults to highlight tab for unknown motivation', () => {
    const vm = createBrowseVM(tc.client);
    const tabs: string[] = [];
    vm.panelInitialTab$.subscribe(v => { if (v) tabs.push(v.tab); });

    tc.client.emit('browse:panel-open', { panel: 'annotations', motivation: 'unknown-thing' });
    expect(tabs[tabs.length - 1]).toBe('highlight');
    vm.dispose();
  });

  it('increments generation counter on each panel open with motivation', () => {
    const vm = createBrowseVM(tc.client);
    const generations: number[] = [];
    vm.panelInitialTab$.subscribe(v => { if (v) generations.push(v.generation); });

    tc.client.emit('browse:panel-open', { panel: 'annotations', motivation: 'highlighting' });
    tc.client.emit('browse:panel-open', { panel: 'annotations', motivation: 'highlighting' });
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBeGreaterThan(generations[0]);
    vm.dispose();
  });

  it('closes panel on browse:panel-close', () => {
    const vm = createBrowseVM(tc.client, { initialPanel: 'annotations' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    tc.client.emit('browse:panel-close', undefined);
    expect(values).toEqual(['annotations', null]);
    vm.dispose();
  });

  it('clears scrollToAnnotationId on onScrollCompleted', () => {
    const vm = createBrowseVM(tc.client);
    const scrolls: (string | null)[] = [];
    vm.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    tc.client.emit('browse:panel-open', { panel: 'annotations', scrollToAnnotationId: 'ann-1' });
    vm.onScrollCompleted();
    expect(scrolls).toEqual([null, 'ann-1', null]);
    vm.dispose();
  });

  it('calls onPanelChange callback', () => {
    const cb = vi.fn();
    const vm = createBrowseVM(tc.client, { initialPanel: 'info', onPanelChange: cb });
    expect(cb).toHaveBeenCalledWith('info');

    tc.client.emit('browse:panel-toggle', { panel: 'info' });
    expect(cb).toHaveBeenCalledWith(null);
    vm.dispose();
  });

  it('openPanel command pushes to EventBus', () => {
    const vm = createBrowseVM(tc.client);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.openPanel('settings');
    expect(values).toEqual([null, 'settings']);
    vm.dispose();
  });

  it('closePanel command pushes to EventBus', () => {
    const vm = createBrowseVM(tc.client, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.closePanel();
    expect(values).toEqual(['info', null]);
    vm.dispose();
  });

  it('togglePanel command pushes to EventBus', () => {
    const vm = createBrowseVM(tc.client);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.togglePanel('annotations');
    vm.togglePanel('annotations');
    expect(values).toEqual([null, 'annotations', null]);
    vm.dispose();
  });

  it('stops responding after dispose', () => {
    const vm = createBrowseVM(tc.client);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.dispose();
    tc.client.emit('browse:panel-open', { panel: 'info' });
    expect(values).toEqual([null]);
  });
});
