/**
 * "A new login should always lead to the KB panel" — whatever panel was showing,
 * not just the Account one. Settings is the case that matters here: it is usable
 * signed out, so it legitimately survives into the sign-in, and it must still give
 * way once a session exists.
 *
 * Driven through a real ShellStateUnit on a real browser bus, because `openPanel`
 * EMITS `panel:open` and the unit listens for it — a stubbed bus would let a broken
 * rule pass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SemiontBrowser, createHttpSessionFactory } from '@semiont/sdk';
import { WebBrowserStorage, createShellStateUnit, type ToolbarPanelType } from '@semiont/react-ui';
import { useKbPanelOnLogin } from '../useKbPanelOnLogin';

function shellShowing(panel: ToolbarPanelType) {
  const browser = new SemiontBrowser({
    storage: new WebBrowserStorage(),
    sessionFactory: createHttpSessionFactory(),
  });
  // A real unit on the real bus observes what the hook emits.
  const unit = createShellStateUnit(browser, { initialPanel: panel });
  const seen: (ToolbarPanelType | null)[] = [];
  unit.activePanel$.subscribe((v) => seen.push(v));
  return { browser, unit, seen };
}

describe('a new session opens the Knowledge Base panel', () => {
  beforeEach(() => localStorage.clear());

  it('takes over from Settings — the rule is not specific to the Account panel', () => {
    const { browser, seen } = shellShowing('settings');

    const { rerender } = renderHook(({ signedIn }) => useKbPanelOnLogin(signedIn, browser), {
      initialProps: { signedIn: false },
    });
    expect(seen.at(-1)).toBe('settings');

    rerender({ signedIn: true });

    expect(seen.at(-1)).toBe('knowledge-base');
  });

  it('fires for a session already restored at first render', () => {
    const { browser, seen } = shellShowing('annotations');

    renderHook(() => useKbPanelOnLogin(true, browser));

    expect(seen.at(-1)).toBe('knowledge-base');
  });

  it('does not re-open the panel on later renders, so the viewer can open its own', () => {
    const { browser, unit, seen } = shellShowing('settings');
    const { rerender } = renderHook(({ signedIn }) => useKbPanelOnLogin(signedIn, browser), {
      initialProps: { signedIn: false },
    });
    rerender({ signedIn: true });
    expect(seen.at(-1)).toBe('knowledge-base');

    // What the resource viewer does once a resource is open.
    unit.openPanel('annotations');
    rerender({ signedIn: true });

    expect(seen.at(-1)).toBe('annotations');
  });
});
