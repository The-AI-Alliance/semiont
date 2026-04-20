'use client';

import { createBrowseVM, type BrowseVM, type ToolbarPanelType } from '@semiont/api-client';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';
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
  const client = useObservable(useSemiont().activeSession$)?.client;
  return useViewModel(() => createBrowseVM(client!, {
    initialPanel: readPanel(),
    onPanelChange: persistPanel,
  }));
}
