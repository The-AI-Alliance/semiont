'use client';

import { createShellVM, type ShellVM, type ToolbarPanelType } from '@semiont/api-client';
import { useSemiont } from '../session/SemiontProvider';
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

/**
 * `ShellVM` is app-scoped — it owns toolbar panel state and lives on
 * the `SemiontBrowser`'s own bus. Unlike session-scoped VMs, this hook
 * does not need to wait for an active KB session; `useSemiont()`
 * always returns the module-scoped `SemiontBrowser` singleton.
 */
export function useShellVM(): ShellVM {
  const semiont = useSemiont();
  return useViewModel(() => createShellVM(semiont, {
    initialPanel: readPanel(),
    onPanelChange: persistPanel,
  }));
}
