/**
 * ShellVM — app-shell state: which toolbar panel is open, tab-bar
 * coordination helpers, scroll-to-annotation signals. Lives on
 * `SemiontBrowser`'s app-scoped bus (not the per-session client bus)
 * because panel toggles and shell chrome must work regardless of
 * whether a KB session is active.
 *
 * Channels: `panel:toggle`, `panel:open`, `panel:close`.
 */

import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { SemiontBrowser } from '../../session/semiont-browser';
import type { ViewModel } from '../lib/view-model';

export type ToolbarPanelType = 'history' | 'info' | 'annotations' | 'settings' | 'collaboration' | 'user' | 'jsonld' | 'knowledge-base';

export const COMMON_PANELS: readonly ToolbarPanelType[] = ['knowledge-base', 'user', 'settings'] as const;
export const RESOURCE_PANELS: readonly ToolbarPanelType[] = ['history', 'info', 'annotations', 'collaboration', 'jsonld'] as const;

const MOTIVATION_TO_TAB: Record<string, string> = {
  'linking': 'reference',
  'commenting': 'comment',
  'tagging': 'tag',
  'highlighting': 'highlight',
  'assessing': 'assessment',
};

let tabGenerationCounter = 0;

export interface ShellVM extends ViewModel {
  activePanel$: Observable<ToolbarPanelType | null>;
  scrollToAnnotationId$: Observable<string | null>;
  panelInitialTab$: Observable<{ tab: string; generation: number } | null>;
  openPanel(panel: string): void;
  closePanel(): void;
  togglePanel(panel: string): void;
  onScrollCompleted(): void;
}

export interface ShellVMOptions {
  initialPanel?: ToolbarPanelType | null;
  onPanelChange?: (panel: ToolbarPanelType | null) => void;
}

export function createShellVM(browser: SemiontBrowser, options?: ShellVMOptions): ShellVM {
  const subs: Subscription[] = [];
  const activePanel$ = new BehaviorSubject<ToolbarPanelType | null>(options?.initialPanel ?? null);
  const scrollToAnnotationId$ = new BehaviorSubject<string | null>(null);
  const panelInitialTab$ = new BehaviorSubject<{ tab: string; generation: number } | null>(null);

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
      const tab = MOTIVATION_TO_TAB[motivation] || 'highlight';
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
