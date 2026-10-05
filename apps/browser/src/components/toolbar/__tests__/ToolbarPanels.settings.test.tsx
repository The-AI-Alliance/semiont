/**
 * ToolbarPanels owns APPLYING the settings its panel emits.
 *
 * The Theme, Line Numbers and Locale handlers live HERE, in the component
 * that is mounted wherever the panel renders, so the panel being mounted and
 * the panel working are the same condition. A per-route subscription leaves
 * a control dead on any route without one, the signed-out knowledge layout
 * among them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const captured = vi.hoisted(() => ({
  subs: null as Record<string, (payload?: unknown) => void> | null,
}));
const spies = vi.hoisted(() => ({
  setTheme: vi.fn(),
  toggleLineNumbers: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('@/i18n/routing', () => ({
  useLocale: () => 'en',
  usePathname: () => '/know/discover',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('../../UserPanel', () => ({ UserPanel: () => null }));
vi.mock('../../KnowledgeBasePanel', () => ({ KnowledgeBasePanel: () => null }));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  const { BehaviorSubject } = await vi.importActual<typeof import('rxjs')>('rxjs');
  return {
    ...actual,
    useEventSubscriptions: (subs: Record<string, (payload?: unknown) => void>) => {
      captured.subs = subs;
    },
    useTheme: () => ({ theme: 'system', resolvedTheme: 'light', setTheme: spies.setTheme }),
    useLineNumbers: () => ({ showLineNumbers: false, toggleLineNumbers: spies.toggleLineNumbers }),
    useSemiont: () => ({ activeSession$: new BehaviorSubject(null) }),
    useHoverDelay: () => ({ hoverDelayMs: 150 }),
    usePanelWidth: () => ({ width: 320, setWidth: vi.fn(), minWidth: 200, maxWidth: 600 }),
  };
});

import { ToolbarPanels } from '../ToolbarPanels';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';

const keyboardShortcuts = { openKeyboardHelp: vi.fn() };

/** ToolbarPanels as the app mounts it: inside the keyboard-shortcuts context. */
function renderPanels() {
  return render(
    <KeyboardShortcutsContext.Provider value={keyboardShortcuts}>
      <ToolbarPanels activePanel={null} theme="system" />
    </KeyboardShortcutsContext.Provider>,
  );
}

describe('ToolbarPanels — settings application lives with the panel', () => {
  beforeEach(() => {
    captured.subs = null;
    spies.setTheme.mockClear();
    spies.toggleLineNumbers.mockClear();
  });

  it('applies settings:theme-changed itself, so the control works wherever the panel renders', () => {
    renderPanels();

    expect(captured.subs).not.toBeNull();
    const handler = captured.subs!['settings:theme-changed'];
    expect(handler).toBeDefined();

    handler!({ theme: 'dark' });
    expect(spies.setTheme).toHaveBeenCalledWith('dark');
  });

  it('applies settings:line-numbers-toggled itself', () => {
    renderPanels();

    const handler = captured.subs!['settings:line-numbers-toggled'];
    expect(handler).toBeDefined();

    handler!();
    expect(spies.toggleLineNumbers).toHaveBeenCalledTimes(1);
  });

  it('registers the locale handler alongside the other two', () => {
    renderPanels();

    expect(captured.subs!['settings:locale-changed']).toBeDefined();
  });

  it('subscribes even with no panel open — settings apply regardless of panel visibility', () => {
    renderPanels();

    // The component renders null for activePanel=null, but the hooks above
    // the early return must still have registered the handlers.
    expect(captured.subs).not.toBeNull();
  });
});
