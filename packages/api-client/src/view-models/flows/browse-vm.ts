import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { EventBus } from '@semiont/core';
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

export interface BrowseVM extends ViewModel {
  activePanel$: Observable<ToolbarPanelType | null>;
  scrollToAnnotationId$: Observable<string | null>;
  panelInitialTab$: Observable<{ tab: string; generation: number } | null>;
  openPanel(panel: string): void;
  closePanel(): void;
  togglePanel(panel: string): void;
  onScrollCompleted(): void;
}

export interface BrowseVMOptions {
  initialPanel?: ToolbarPanelType | null;
  onPanelChange?: (panel: ToolbarPanelType | null) => void;
}

export function createBrowseVM(eventBus: EventBus, options?: BrowseVMOptions): BrowseVM {
  const subs: Subscription[] = [];
  const activePanel$ = new BehaviorSubject<ToolbarPanelType | null>(options?.initialPanel ?? null);
  const scrollToAnnotationId$ = new BehaviorSubject<string | null>(null);
  const panelInitialTab$ = new BehaviorSubject<{ tab: string; generation: number } | null>(null);

  if (options?.onPanelChange) {
    const cb = options.onPanelChange;
    subs.push(activePanel$.subscribe(cb));
  }

  subs.push(eventBus.get('browse:panel-toggle').subscribe(({ panel }) => {
    const current = activePanel$.getValue();
    activePanel$.next(current === panel ? null : panel as ToolbarPanelType);
  }));

  subs.push(eventBus.get('browse:panel-open').subscribe(({ panel, scrollToAnnotationId, motivation }) => {
    if (scrollToAnnotationId) {
      scrollToAnnotationId$.next(scrollToAnnotationId);
    }
    if (motivation) {
      const tab = MOTIVATION_TO_TAB[motivation] || 'highlight';
      panelInitialTab$.next({ tab, generation: ++tabGenerationCounter });
    }
    activePanel$.next(panel as ToolbarPanelType);
  }));

  subs.push(eventBus.get('browse:panel-close').subscribe(() => {
    activePanel$.next(null);
  }));

  return {
    activePanel$: activePanel$.asObservable(),
    scrollToAnnotationId$: scrollToAnnotationId$.asObservable(),
    panelInitialTab$: panelInitialTab$.asObservable(),
    openPanel: (panel) => eventBus.get('browse:panel-open').next({ panel }),
    closePanel: () => eventBus.get('browse:panel-close').next(undefined),
    togglePanel: (panel) => eventBus.get('browse:panel-toggle').next({ panel }),
    onScrollCompleted: () => scrollToAnnotationId$.next(null),
    dispose() {
      subs.forEach(s => s.unsubscribe());
      activePanel$.complete();
      scrollToAnnotationId$.complete();
      panelInitialTab$.complete();
    },
  };
}
