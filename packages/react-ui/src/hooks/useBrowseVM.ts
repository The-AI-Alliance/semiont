'use client';

import { createBrowseVM, type BrowseVM, type ToolbarPanelType } from '@semiont/api-client';
import { useEventBus } from '../contexts/EventBusContext';
import { useViewModel } from './useViewModel';

function readPanel(): ToolbarPanelType | null {
  if (typeof window === 'undefined') return null;
  const saved = localStorage.getItem('activeToolbarPanel');
  return (saved as ToolbarPanelType) || 'knowledge-base';
}

function persistPanel(panel: ToolbarPanelType | null): void {
  if (typeof window === 'undefined') return;
  if (panel) localStorage.setItem('activeToolbarPanel', panel);
  else localStorage.removeItem('activeToolbarPanel');
}

export function useBrowseVM(): BrowseVM {
  const eventBus = useEventBus();
  return useViewModel(() => createBrowseVM(eventBus, {
    initialPanel: readPanel(),
    onPanelChange: persistPanel,
  }));
}
