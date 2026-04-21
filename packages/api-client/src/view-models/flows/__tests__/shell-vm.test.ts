import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShellVM } from '../shell-vm';
import { SemiontBrowser } from '../../../session/semiont-browser';
import { InMemorySessionStorage } from '../../../session/session-storage';

/**
 * Tests for ShellVM — the app-scoped VM that owns toolbar panel state.
 * Uses a real `SemiontBrowser` with an in-memory storage adapter because
 * the VM is thin and the browser's own bus is what we're exercising.
 */
describe('createShellVM', () => {
  let browser: SemiontBrowser;

  beforeEach(() => { browser = new SemiontBrowser({ storage: new InMemorySessionStorage() }); });
  afterEach(async () => { await browser.dispose(); });

  it('starts with the given initial panel', () => {
    const vm = createShellVM(browser, { initialPanel: 'knowledge-base' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual(['knowledge-base']);
    vm.dispose();
  });

  it('defaults to null when no initial panel', () => {
    const vm = createShellVM(browser);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual([null]);
    vm.dispose();
  });

  it('toggles panel on panel:toggle', () => {
    const vm = createShellVM(browser);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:toggle', { panel: 'annotations' });
    expect(values).toEqual([null, 'annotations']);

    browser.emit('panel:toggle', { panel: 'annotations' });
    expect(values).toEqual([null, 'annotations', null]);
    vm.dispose();
  });

  it('switches panel when toggling a different one', () => {
    const vm = createShellVM(browser, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:toggle', { panel: 'annotations' });
    expect(values).toEqual(['info', 'annotations']);
    vm.dispose();
  });

  it('opens panel on panel:open', () => {
    const vm = createShellVM(browser);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:open', { panel: 'history' });
    expect(values).toEqual([null, 'history']);
    vm.dispose();
  });

  it('sets scrollToAnnotationId on panel:open with scrollTarget', () => {
    const vm = createShellVM(browser);
    const scrolls: (string | null)[] = [];
    vm.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    browser.emit('panel:open', { panel: 'annotations', scrollToAnnotationId: 'ann-42' });
    expect(scrolls).toEqual([null, 'ann-42']);
    vm.dispose();
  });

  it('maps all motivations to correct tab keys', () => {
    const vm = createShellVM(browser);
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
      browser.emit('panel:open', { panel: 'annotations', motivation });
      expect(tabs[tabs.length - 1]).toBe(expected);
    }
    vm.dispose();
  });

  it('defaults to highlight tab for unknown motivation', () => {
    const vm = createShellVM(browser);
    const tabs: string[] = [];
    vm.panelInitialTab$.subscribe(v => { if (v) tabs.push(v.tab); });

    browser.emit('panel:open', { panel: 'annotations', motivation: 'unknown-thing' });
    expect(tabs[tabs.length - 1]).toBe('highlight');
    vm.dispose();
  });

  it('increments generation counter on each panel open with motivation', () => {
    const vm = createShellVM(browser);
    const generations: number[] = [];
    vm.panelInitialTab$.subscribe(v => { if (v) generations.push(v.generation); });

    browser.emit('panel:open', { panel: 'annotations', motivation: 'highlighting' });
    browser.emit('panel:open', { panel: 'annotations', motivation: 'highlighting' });
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBeGreaterThan(generations[0]);
    vm.dispose();
  });

  it('closes panel on panel:close', () => {
    const vm = createShellVM(browser, { initialPanel: 'annotations' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:close', undefined);
    expect(values).toEqual(['annotations', null]);
    vm.dispose();
  });

  it('clears scrollToAnnotationId on onScrollCompleted', () => {
    const vm = createShellVM(browser);
    const scrolls: (string | null)[] = [];
    vm.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    browser.emit('panel:open', { panel: 'annotations', scrollToAnnotationId: 'ann-1' });
    vm.onScrollCompleted();
    expect(scrolls).toEqual([null, 'ann-1', null]);
    vm.dispose();
  });

  it('calls onPanelChange callback', () => {
    const cb = vi.fn();
    const vm = createShellVM(browser, { initialPanel: 'info', onPanelChange: cb });
    expect(cb).toHaveBeenCalledWith('info');

    browser.emit('panel:toggle', { panel: 'info' });
    expect(cb).toHaveBeenCalledWith(null);
    vm.dispose();
  });

  it('openPanel command pushes to bus', () => {
    const vm = createShellVM(browser);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.openPanel('settings');
    expect(values).toEqual([null, 'settings']);
    vm.dispose();
  });

  it('closePanel command pushes to bus', () => {
    const vm = createShellVM(browser, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.closePanel();
    expect(values).toEqual(['info', null]);
    vm.dispose();
  });

  it('togglePanel command pushes to bus', () => {
    const vm = createShellVM(browser);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.togglePanel('annotations');
    vm.togglePanel('annotations');
    expect(values).toEqual([null, 'annotations', null]);
    vm.dispose();
  });

  it('stops responding after dispose', () => {
    const vm = createShellVM(browser);
    const values: (string | null)[] = [];
    vm.activePanel$.subscribe(v => values.push(v));

    vm.dispose();
    browser.emit('panel:open', { panel: 'info' });
    expect(values).toEqual([null]);
  });
});
