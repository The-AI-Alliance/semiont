import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShellStateUnit } from '../shell-state-unit';
import { SemiontBrowser } from '@semiont/sdk';
import { createHttpSessionFactory } from '@semiont/sdk';
import { InMemorySessionStorage } from '@semiont/sdk';

/**
 * Tests for ShellStateUnit — the app-scoped state unit that owns toolbar panel state.
 * Uses a real `SemiontBrowser` with an in-memory storage adapter because
 * the state unit is thin and the browser's own bus is what we're exercising.
 */
describe('createShellStateUnit', () => {
  let browser: SemiontBrowser;

  beforeEach(() => {
    browser = new SemiontBrowser({
      storage: new InMemorySessionStorage(),
      sessionFactory: createHttpSessionFactory(),
    });
  });
  afterEach(async () => { await browser.dispose(); });

  it('starts with the given initial panel', () => {
    const stateUnit = createShellStateUnit(browser, { initialPanel: 'knowledge-base' });
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual(['knowledge-base']);
    stateUnit.dispose();
  });

  it('defaults to null when no initial panel', () => {
    const stateUnit = createShellStateUnit(browser);
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));
    expect(values).toEqual([null]);
    stateUnit.dispose();
  });

  it('toggles panel on panel:toggle', () => {
    const stateUnit = createShellStateUnit(browser);
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:toggle', { panel: 'annotations' });
    expect(values).toEqual([null, 'annotations']);

    browser.emit('panel:toggle', { panel: 'annotations' });
    expect(values).toEqual([null, 'annotations', null]);
    stateUnit.dispose();
  });

  it('switches panel when toggling a different one', () => {
    const stateUnit = createShellStateUnit(browser, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:toggle', { panel: 'annotations' });
    expect(values).toEqual(['info', 'annotations']);
    stateUnit.dispose();
  });

  it('opens panel on panel:open', () => {
    const stateUnit = createShellStateUnit(browser);
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:open', { panel: 'history' });
    expect(values).toEqual([null, 'history']);
    stateUnit.dispose();
  });

  it('sets scrollToAnnotationId on panel:open with scrollTarget', () => {
    const stateUnit = createShellStateUnit(browser);
    const scrolls: (string | null)[] = [];
    stateUnit.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    browser.emit('panel:open', { panel: 'annotations', scrollToAnnotationId: 'ann-42' });
    expect(scrolls).toEqual([null, 'ann-42']);
    stateUnit.dispose();
  });

  it('maps all motivations to correct tab keys', () => {
    const stateUnit = createShellStateUnit(browser);
    const tabs: string[] = [];
    stateUnit.panelInitialTab$.subscribe(v => { if (v) tabs.push(v.tab); });

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
    stateUnit.dispose();
  });

  it('defaults to highlight tab for unknown motivation', () => {
    const stateUnit = createShellStateUnit(browser);
    const tabs: string[] = [];
    stateUnit.panelInitialTab$.subscribe(v => { if (v) tabs.push(v.tab); });

    browser.emit('panel:open', { panel: 'annotations', motivation: 'unknown-thing' });
    expect(tabs[tabs.length - 1]).toBe('highlight');
    stateUnit.dispose();
  });

  it('increments generation counter on each panel open with motivation', () => {
    const stateUnit = createShellStateUnit(browser);
    const generations: number[] = [];
    stateUnit.panelInitialTab$.subscribe(v => { if (v) generations.push(v.generation); });

    browser.emit('panel:open', { panel: 'annotations', motivation: 'highlighting' });
    browser.emit('panel:open', { panel: 'annotations', motivation: 'highlighting' });
    expect(generations).toHaveLength(2);
    expect(generations[1]).toBeGreaterThan(generations[0]);
    stateUnit.dispose();
  });

  it('closes panel on panel:close', () => {
    const stateUnit = createShellStateUnit(browser, { initialPanel: 'annotations' });
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    browser.emit('panel:close', undefined);
    expect(values).toEqual(['annotations', null]);
    stateUnit.dispose();
  });

  it('clears scrollToAnnotationId on onScrollCompleted', () => {
    const stateUnit = createShellStateUnit(browser);
    const scrolls: (string | null)[] = [];
    stateUnit.scrollToAnnotationId$.subscribe(v => scrolls.push(v));

    browser.emit('panel:open', { panel: 'annotations', scrollToAnnotationId: 'ann-1' });
    stateUnit.onScrollCompleted();
    expect(scrolls).toEqual([null, 'ann-1', null]);
    stateUnit.dispose();
  });

  it('calls onPanelChange callback', () => {
    const cb = vi.fn();
    const stateUnit = createShellStateUnit(browser, { initialPanel: 'info', onPanelChange: cb });
    expect(cb).toHaveBeenCalledWith('info');

    browser.emit('panel:toggle', { panel: 'info' });
    expect(cb).toHaveBeenCalledWith(null);
    stateUnit.dispose();
  });

  it('openPanel command pushes to bus', () => {
    const stateUnit = createShellStateUnit(browser);
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    stateUnit.openPanel('settings');
    expect(values).toEqual([null, 'settings']);
    stateUnit.dispose();
  });

  it('closePanel command pushes to bus', () => {
    const stateUnit = createShellStateUnit(browser, { initialPanel: 'info' });
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    stateUnit.closePanel();
    expect(values).toEqual(['info', null]);
    stateUnit.dispose();
  });

  it('togglePanel command pushes to bus', () => {
    const stateUnit = createShellStateUnit(browser);
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    stateUnit.togglePanel('annotations');
    stateUnit.togglePanel('annotations');
    expect(values).toEqual([null, 'annotations', null]);
    stateUnit.dispose();
  });

  it('stops responding after dispose', () => {
    const stateUnit = createShellStateUnit(browser);
    const values: (string | null)[] = [];
    stateUnit.activePanel$.subscribe(v => values.push(v));

    stateUnit.dispose();
    browser.emit('panel:open', { panel: 'info' });
    expect(values).toEqual([null]);
  });
});
