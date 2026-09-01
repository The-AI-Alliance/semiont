/**
 * Signed out, the empty state says "Sign in using the Knowledge Base panel" —
 * so that panel has to be the one that is open. It was not: `activeToolbarPanel`
 * persists across sessions, so anyone whose last panel was Account came back to
 * a dead end reading "Sign in to a knowledge base to view your account", while
 * the main area pointed at a panel the app had not opened.
 *
 * `user` is the only auth-requiring panel (ToolbarPanels renders a signed-out
 * fallback for it and nothing else), so the redirect is narrow: Settings still
 * works signed out — theme, locale and line numbers are exactly what you can
 * change without a session — and must NOT be hijacked.
 *
 * A real `SemiontBrowser` goes through `SemiontProvider` rather than a faked
 * `useSemiont`: `useShellStateUnit` resolves from react-ui's dist bundle, whose
 * internal `useSemiont` call a package-level mock cannot rewire. It also keeps
 * the real bus, which this depends on — `openPanel` EMITS `panel:open` and the
 * ShellStateUnit listens for it, so a stubbed bus would leave the fix inert here
 * while working in the app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { SemiontProvider, ThemeProvider, WebBrowserStorage } from '@semiont/react-ui';
import { SemiontBrowser, createHttpSessionFactory } from '@semiont/sdk';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

/** Records the panel the layout hands to the toolbar on each render. */
const seen: (string | null)[] = [];
vi.mock('@/components/toolbar/ToolbarPanels', () => ({
  ToolbarPanels: ({ activePanel }: { activePanel: string | null }) => {
    seen.push(activePanel);
    return null;
  },
}));

vi.mock('@/components/knowledge/KnowledgeSidebarWrapper', () => ({ KnowledgeSidebarWrapper: () => null }));
vi.mock('@/components/CookiePreferences', () => ({ CookiePreferences: () => null }));
vi.mock('@/lib/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  routes: {},
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return { ...actual, Toolbar: () => null, Footer: () => null };
});

import KnowledgeLayout from '../layout';

function renderSignedOut() {
  const browser = new SemiontBrowser({
    storage: new WebBrowserStorage(),
    sessionFactory: createHttpSessionFactory(),
  });
  return render(
    <SemiontProvider browser={browser}>
      <ThemeProvider>
        <KnowledgeLayout />
      </ThemeProvider>
    </SemiontProvider>,
  );
}

describe('signed-out knowledge layout: which panel is open', () => {
  beforeEach(() => {
    seen.length = 0;
    // No KBs, no session: a fresh browser is signed out by construction.
    localStorage.clear();
  });

  it('opens the Knowledge Base panel when the persisted panel is the signed-out dead end', () => {
    localStorage.setItem('activeToolbarPanel', 'user');

    renderSignedOut();

    expect(seen.at(-1)).toBe('knowledge-base');
  });

  it('leaves Settings alone — it works without a session', () => {
    localStorage.setItem('activeToolbarPanel', 'settings');

    renderSignedOut();

    expect(seen.at(-1)).toBe('settings');
  });
});
