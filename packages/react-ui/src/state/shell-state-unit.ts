/**
 * ShellStateUnit — app-shell state: which toolbar panel is open, tab-bar
 * coordination helpers, scroll-to-annotation signals. Lives on
 * `SemiontBrowser`'s app-scoped bus (not the per-session client bus)
 * because panel toggles and shell chrome must work regardless of
 * whether a KB session is active.
 *
 * Channels: `panel:toggle`, `panel:open`, `panel:close`.
 */

import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { SemiontBrowser } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import { annotatorKeyForMotivation, type AnnotatorKey } from '../lib/annotation-registry';

export type ToolbarPanelType = 'history' | 'info' | 'annotations' | 'settings' | 'collaboration' | 'user' | 'jsonld' | 'knowledge-base';

export const COMMON_PANELS: readonly ToolbarPanelType[] = ['knowledge-base', 'user', 'settings'] as const;
export const RESOURCE_PANELS: readonly ToolbarPanelType[] = ['history', 'info', 'annotations', 'collaboration', 'jsonld'] as const;

export interface ShellStateUnit extends StateUnit {
  activePanel$: Observable<ToolbarPanelType | null>;
  scrollToAnnotationId$: Observable<string | null>;
  panelInitialTab$: Observable<{ tab: AnnotatorKey; generation: number } | null>;
  openPanel(panel: string): void;
  closePanel(): void;
  togglePanel(panel: string): void;
  onScrollCompleted(): void;
}

export interface ShellStateUnitOptions {
  initialPanel?: ToolbarPanelType | null;
  onPanelChange?: (panel: ToolbarPanelType | null) => void;
}

export function createShellStateUnit(browser: SemiontBrowser, options?: ShellStateUnitOptions): ShellStateUnit {
  const subs: Subscription[] = [];
  const activePanel$ = new BehaviorSubject<ToolbarPanelType | null>(options?.initialPanel ?? null);
  const scrollToAnnotationId$ = new BehaviorSubject<string | null>(null);
  const panelInitialTab$ = new BehaviorSubject<{ tab: AnnotatorKey; generation: number } | null>(null);
  // Per-instance monotonic tab-generation counter. Was module-scoped — shared across
  // every ShellStateUnit, an X3 instance-isolation leak; closure-scoped here.
  let tabGenerationCounter = 0;

  if (options?.onPanelChange) {
    const cb = options.onPanelChange;
    subs.push(activePanel$.subscribe(cb));
  }

  subs.push(browser.stream('panel:toggle').subscribe(({ panel }) => {
    const current = activePanel$.getValue();
    activePanel$.next(current === panel ? null : panel as ToolbarPanelType);
  }));

  subs.push(browser.stream('panel:open').subscribe(({ panel, scrollToAnnotationId, motivation }) => {
    if (scrollToAnnotationId) {
      scrollToAnnotationId$.next(scrollToAnnotationId);
    }
    if (motivation) {
      // Derived from ANNOTATORS (the single motivation↔annotator source).
      // The payload's motivation is a loose string (BrowsePanelOpenEvent),
      // so unknown values fall back to the highlight tab.
      const tab = annotatorKeyForMotivation(motivation) ?? 'highlight';
      panelInitialTab$.next({ tab, generation: ++tabGenerationCounter });
    }
    activePanel$.next(panel as ToolbarPanelType);
  }));

  subs.push(browser.stream('panel:close').subscribe(() => {
    activePanel$.next(null);
  }));

  return {
    activePanel$: activePanel$.asObservable(),
    scrollToAnnotationId$: scrollToAnnotationId$.asObservable(),
    panelInitialTab$: panelInitialTab$.asObservable(),
    openPanel: (panel) => browser.emit('panel:open', { panel }),
    closePanel: () => browser.emit('panel:close', undefined),
    togglePanel: (panel) => browser.emit('panel:toggle', { panel }),
    onScrollCompleted: () => scrollToAnnotationId$.next(null),
    dispose() {
      subs.forEach(s => s.unsubscribe());
      activePanel$.complete();
      scrollToAnnotationId$.complete();
      panelInitialTab$.complete();
    },
  };
}
