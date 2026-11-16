'use client';

import { createShellStateUnit, type ShellStateUnit, type ToolbarPanelType } from '../state/shell-state-unit';
import { useSemiont } from '../session/SemiontProvider';
import { useStateUnit } from './useStateUnit';

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
 * `ShellStateUnit` is app-scoped — it owns toolbar panel state and lives on
 * the `SemiontBrowser`'s own bus. Unlike session-scoped VMs, this hook
 * does not need to wait for an active KB session; `useSemiont()`
 * always returns the module-scoped `SemiontBrowser` singleton.
 */
export function useShellStateUnit(): ShellStateUnit {
  const semiont = useSemiont();
  return useStateUnit(() => createShellStateUnit(semiont, {
    initialPanel: readPanel(),
    onPanelChange: persistPanel,
  }));
}
