/**
 * ToolbarPanels owns APPLYING the settings its panel emits.
 *
 * Theme and Line Numbers were applied by per-route subscriptions — eleven
 * copies — and the signed-out knowledge layout never got one, so both
 * controls were visibly dead when signed out (the two chronic e2e reds in
 * 13-settings-panel.spec.ts). Locale never had the problem because its
 * handler lives HERE, in the component that is mounted wherever the panel
 * renders. This pins the hoist: the panel being mounted and the panel
 * working are the same condition.
 *
 * See .plans/bugs/settings-theme-and-line-numbers-inert-when-signed-out.md
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

describe('ToolbarPanels — settings application lives with the panel', () => {
  beforeEach(() => {
    captured.subs = null;
    spies.setTheme.mockClear();
    spies.toggleLineNumbers.mockClear();
  });

  it('applies settings:theme-changed itself, so the control works wherever the panel renders', () => {
    render(<ToolbarPanels activePanel={null} theme="system" showLineNumbers={false} />);

    expect(captured.subs).not.toBeNull();
    const handler = captured.subs!['settings:theme-changed'];
    expect(handler).toBeDefined();

    handler!({ theme: 'dark' });
    expect(spies.setTheme).toHaveBeenCalledWith('dark');
  });

  it('applies settings:line-numbers-toggled itself', () => {
    render(<ToolbarPanels activePanel={null} theme="system" showLineNumbers={false} />);

    const handler = captured.subs!['settings:line-numbers-toggled'];
    expect(handler).toBeDefined();

    handler!();
    expect(spies.toggleLineNumbers).toHaveBeenCalledTimes(1);
  });

  it('keeps the locale handler registered — the control that always worked must not regress', () => {
    render(<ToolbarPanels activePanel={null} theme="system" showLineNumbers={false} />);

    expect(captured.subs!['settings:locale-changed']).toBeDefined();
  });

  it('subscribes even with no panel open — settings apply regardless of panel visibility', () => {
    render(<ToolbarPanels activePanel={null} theme="system" showLineNumbers={false} />);

    // The component renders null for activePanel=null, but the hooks above
    // the early return must still have registered the handlers.
    expect(captured.subs).not.toBeNull();
  });
});
