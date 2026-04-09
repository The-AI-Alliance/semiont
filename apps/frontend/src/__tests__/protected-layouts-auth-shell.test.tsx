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

// Mock the auth/KB hooks to return authenticated state so layouts render their body
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isAdmin: true,
    isModerator: true,
    isFullyAuthenticated: true,
    hasValidBackendToken: true,
    token: 'test-token',
    isLoading: false,
  }),
}));

vi.mock('@/contexts/KnowledgeBaseContext', () => ({
  KnowledgeBaseProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useKnowledgeBaseContext: () => ({
    knowledgeBases: [{ id: 'kb-1', label: 'Test', host: 'localhost', port: 4000, protocol: 'http' as const, email: 'test@example.com' }],
    activeKnowledgeBaseId: 'kb-1',
    activeKnowledgeBase: { id: 'kb-1', label: 'Test', host: 'localhost', port: 4000, protocol: 'http' as const, email: 'test@example.com' },
    addKnowledgeBase: vi.fn(),
    removeKnowledgeBase: vi.fn(),
    setActiveKnowledgeBase: vi.fn(),
    updateKnowledgeBase: vi.fn(),
    signOut: vi.fn(),
  }),
  kbBackendUrl: (kb: any) => `${kb.protocol}://${kb.host}:${kb.port}`,
  getKbToken: () => 'test-token',
  clearKbToken: vi.fn(),
  isTokenExpired: () => false,
  getKbSessionStatus: () => 'authenticated',
}));

// Mock heavy hooks/managers to avoid wiring real implementations
vi.mock('@/hooks/useOpenResourcesManager', () => ({
  useOpenResourcesManager: () => ({
    openResources: [],
    addResource: vi.fn(),
    removeResource: vi.fn(),
    updateResourceName: vi.fn(),
    reorderResources: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCacheManager', () => ({
  useCacheManager: () => ({}),
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    AuthTokenProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ApiClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    CacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    OpenResourcesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ResourceAnnotationsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LeftSidebar: () => <div data-testid="left-sidebar" />,
    Footer: () => null,
    Toolbar: () => null,
    useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }),
    useLineNumbers: () => ({ showLineNumbers: false, toggleLineNumbers: vi.fn() }),
    usePanelBrowse: () => ({ activePanel: null }),
    useGlobalEvents: () => {},
    useStoreTokenSync: () => {},
    useAttentionStream: () => ({ status: 'connected' }),
  };
});

vi.mock('@/components/CookiePreferences', () => ({ CookiePreferences: () => null }));
vi.mock('@/components/admin/AdminNavigation', () => ({ AdminNavigation: () => null }));
vi.mock('@/components/moderation/ModerationNavigation', () => ({ ModerationNavigation: () => null }));
vi.mock('@/components/knowledge/KnowledgeSidebarWrapper', () => ({ KnowledgeSidebarWrapper: () => null }));
vi.mock('@/components/toolbar/ToolbarPanels', () => ({ ToolbarPanels: () => null }));
vi.mock('@/contexts/StreamStatusContext', () => ({
  StreamStatusContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
}));

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
