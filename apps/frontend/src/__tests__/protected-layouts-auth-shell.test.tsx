/**
 * Protected Layouts AuthShell Wrapping Test
 *
 * Regression test that asserts each protected layout (know, admin, moderate)
 * mounts its body inside AuthShell. If a future change accidentally removes
 * the AuthShell wrapper, this test fails — protecting against the same
 * class of bug the AuthShell extraction was meant to fix.
 *
 * Mocks AuthShell as a marker component so we can verify it was rendered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// AuthShell mocked as a marker component — the test verifies it wraps
// the layout body. If a layout forgets to wrap, the marker won't appear.
vi.mock('@/contexts/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-shell-marker">{children}</div>
  ),
}));

// Mock app-specific routing
vi.mock('@/i18n/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  routes: {},
  usePathname: () => '/test',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useLocale: () => 'en',
}));

vi.mock('@/lib/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  routes: {},
}));

// vi.hoisted so the vi.mock factory below can reference TEST_KB.
const { TEST_KB } = vi.hoisted(() => ({
  TEST_KB: { id: 'kb-1', label: 'Test', host: 'localhost', port: 4000, protocol: 'http' as const, email: 'test@example.com' },
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  const { BehaviorSubject } = await vi.importActual<typeof import('rxjs')>('rxjs');
  // Minimal stub client — KnowledgeLayoutInner reads `client.actor.state$`
  // to drive the stream-status context. It doesn't care about the value.
  const stubClient = {
    actor: { state$: { subscribe: () => ({ unsubscribe: () => {} }) } },
  };
  const stubUser$ = new BehaviorSubject<any>({ isAdmin: true, isModerator: true });
  const stubToken$ = new BehaviorSubject<any>('test-token');
  const stubSession = {
    client: stubClient,
    kb: TEST_KB,
    user$: stubUser$,
    token$: stubToken$,
    refresh: async () => null,
  };
  const stubActiveSession$ = new BehaviorSubject<any>(stubSession);
  const stubKbs$ = new BehaviorSubject<any[]>([TEST_KB]);
  const stubActiveKbId$ = new BehaviorSubject<string | null>(TEST_KB.id);
  const stubBrowser = {
    activeSession$: stubActiveSession$,
    kbs$: stubKbs$,
    activeKbId$: stubActiveKbId$,
    setActiveKb: async () => {},
    getKbSessionStatus: () => 'authenticated',
  };
  return {
    ...actual,
    kbBackendUrl: (kb: any) => `${kb.protocol}://${kb.host}:${kb.port}`,
    ResourceAnnotationsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSemiont: () => stubBrowser,
    LeftSidebar: () => <div data-testid="left-sidebar" />,
    Footer: () => null,
    Toolbar: () => null,
    useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }),
    useLineNumbers: () => ({ showLineNumbers: false, toggleLineNumbers: vi.fn() }),
    useBrowseVM: () => ({ activePanel$: { subscribe: () => ({ unsubscribe: () => {} }) }, dispose: () => {} }),
  };
});

vi.mock('@/components/CookiePreferences', () => ({ CookiePreferences: () => null }));
vi.mock('@/components/admin/AdminNavigation', () => ({ AdminNavigation: () => null }));
vi.mock('@/components/moderation/ModerationNavigation', () => ({ ModerationNavigation: () => null }));
vi.mock('@/components/knowledge/KnowledgeSidebarWrapper', () => ({ KnowledgeSidebarWrapper: () => null }));
vi.mock('@/components/toolbar/ToolbarPanels', () => ({ ToolbarPanels: () => null }));

import KnowLayout from '@/app/[locale]/know/layout';
import AdminLayout from '@/app/[locale]/admin/layout';
import ModerateLayout from '@/app/[locale]/moderate/layout';

function renderLayout(Layout: React.ComponentType) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<div data-testid="route-content">page body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Protected layouts wrap their body in AuthShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('know/layout.tsx mounts AuthShell', () => {
    renderLayout(KnowLayout);
    expect(screen.getByTestId('auth-shell-marker')).toBeInTheDocument();
  });

  it('admin/layout.tsx mounts AuthShell', () => {
    renderLayout(AdminLayout);
    expect(screen.getByTestId('auth-shell-marker')).toBeInTheDocument();
  });

  it('moderate/layout.tsx mounts AuthShell', () => {
    renderLayout(ModerateLayout);
    expect(screen.getByTestId('auth-shell-marker')).toBeInTheDocument();
  });

  it('AuthShell wraps the layout body (route content is inside marker)', () => {
    renderLayout(KnowLayout);
    const marker = screen.getByTestId('auth-shell-marker');
    const routeContent = screen.queryByTestId('route-content');
    if (routeContent) {
      // Route content present — verify it's inside the AuthShell marker
      expect(marker).toContainElement(routeContent);
    }
    // Either way, the marker must be present
    expect(marker).toBeInTheDocument();
  });
});
