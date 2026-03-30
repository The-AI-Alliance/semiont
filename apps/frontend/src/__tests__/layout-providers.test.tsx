/**
 * Layout Provider Tests
 *
 * These tests ensure that all layouts provide the required context providers
 * for their child components. This prevents regressions where providers are
 * accidentally omitted, causing runtime errors.
 *
 * Context: We had bugs where admin/moderate layouts were missing EventBusProvider,
 * ApiClientProvider, and AuthTokenProvider, causing "must be used within" errors.
 */

import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import {
  useAuthToken,
  useApiClient,
  useEventBus,
  EventBusProvider,
} from '@semiont/react-ui';

// Mock routing
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

// Mock hooks
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

vi.mock('@/hooks/useOpenResourcesManager', () => ({
  useOpenResourcesManager: () => ({
    openResources: [],
    openResource: vi.fn(),
    closeResource: vi.fn(),
    setActiveResource: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCacheManager', () => ({
  useCacheManager: () => ({
    invalidate: vi.fn(),
  }),
}));

// Mock components
vi.mock('@/components/CookiePreferences', () => ({
  CookiePreferences: () => <div>Cookie Preferences</div>,
}));

vi.mock('@/components/admin/AdminNavigation', () => ({
  AdminNavigation: () => <div>Admin Navigation</div>,
}));

vi.mock('@/components/moderation/ModerationNavigation', () => ({
  ModerationNavigation: () => <div>Moderation Navigation</div>,
}));

vi.mock('@/components/knowledge/KnowledgeSidebarWrapper', () => ({
  KnowledgeSidebarWrapper: () => <div>Knowledge Sidebar</div>,
}));

// Mock contexts
vi.mock('@/contexts/KeyboardShortcutsContext', () => ({
  KeyboardShortcutsContext: React.createContext(null),
}));

vi.mock('@/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    activeWorkspace: { id: 'test', label: 'localhost', backendUrl: 'http://localhost:4000' },
    workspaces: [],
    activeWorkspaceId: 'test',
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    setActiveWorkspace: vi.fn(),
  }),
}));

/** Render a layout (which uses <Outlet />) with a test child component via React Router. */
function renderLayout(Layout: React.ComponentType, child: React.ReactNode, wrapper?: React.ComponentType<{ children: React.ReactNode }>) {
  const tree = (
    <MemoryRouter initialEntries={['/en/test']}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<>{child}</>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

  return render(wrapper ? React.createElement(wrapper, null, tree) : tree);
}

describe('Layout Providers', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  describe('Admin Layout', () => {
    it('should provide AuthTokenProvider', async () => {
      const { default: AdminLayout } = await import('@/app/[locale]/admin/layout');

      const TestComponent = () => {
        const token = useAuthToken();
        return <div>Token: {token || 'null'}</div>;
      };

      renderLayout(AdminLayout, <TestComponent />);
      expect(screen.getByText(/Token:/)).toBeInTheDocument();
    });

    it('should provide ApiClientProvider', async () => {
      const { default: AdminLayout } = await import('@/app/[locale]/admin/layout');

      const TestComponent = () => {
        const client = useApiClient();
        return <div>Client: {client ? 'present' : 'null'}</div>;
      };

      renderLayout(AdminLayout, <TestComponent />);
      expect(screen.getByText('Client: present')).toBeInTheDocument();
    });

    it('should provide AuthTokenProvider and ApiClientProvider (EventBusProvider is global)', async () => {
      const { default: AdminLayout } = await import('@/app/[locale]/admin/layout');

      const TestComponent = () => {
        const token = useAuthToken();
        const client = useApiClient();
        const eventBus = useEventBus();

        return (
          <div>
            <div>Token: {token ? 'yes' : 'no'}</div>
            <div>Client: {client ? 'yes' : 'no'}</div>
            <div>EventBus: {eventBus ? 'yes' : 'no'}</div>
          </div>
        );
      };

      render(
        <EventBusProvider>
          <MemoryRouter initialEntries={['/en/test']}>
            <Routes>
              <Route element={<AdminLayout />}>
                <Route path="*" element={<TestComponent />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </EventBusProvider>
      );

      expect(screen.getByText('Token: yes')).toBeInTheDocument();
      expect(screen.getByText('Client: yes')).toBeInTheDocument();
      expect(screen.getByText('EventBus: yes')).toBeInTheDocument();
    });
  });

  describe('Moderate Layout', () => {
    it('should provide AuthTokenProvider', async () => {
      const { default: ModerateLayout } = await import('@/app/[locale]/moderate/layout');

      const TestComponent = () => {
        const token = useAuthToken();
        return <div>Token: {token || 'null'}</div>;
      };

      renderLayout(ModerateLayout, <TestComponent />);
      expect(screen.getByText(/Token:/)).toBeInTheDocument();
    });

    it('should provide ApiClientProvider', async () => {
      const { default: ModerateLayout } = await import('@/app/[locale]/moderate/layout');

      const TestComponent = () => {
        const client = useApiClient();
        return <div>Client: {client ? 'present' : 'null'}</div>;
      };

      renderLayout(ModerateLayout, <TestComponent />);
      expect(screen.getByText('Client: present')).toBeInTheDocument();
    });

    it('should work with EventBusProvider from global providers', async () => {
      const { default: ModerateLayout } = await import('@/app/[locale]/moderate/layout');

      const TestComponent = () => {
        const eventBus = useEventBus();
        return <div>EventBus: {eventBus ? 'present' : 'null'}</div>;
      };

      render(
        <EventBusProvider>
          <MemoryRouter initialEntries={['/en/test']}>
            <Routes>
              <Route element={<ModerateLayout />}>
                <Route path="*" element={<TestComponent />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </EventBusProvider>
      );

      expect(screen.getByText('EventBus: present')).toBeInTheDocument();
    });
  });

  describe('Knowledge Layout', () => {
    it('should provide AuthTokenProvider', async () => {
      const { default: KnowledgeLayout } = await import('@/app/[locale]/know/layout');

      const TestComponent = () => {
        const token = useAuthToken();
        return <div>Token: {token || 'null'}</div>;
      };

      render(
        <QueryClientProvider client={queryClient}>
          <EventBusProvider>
            <MemoryRouter initialEntries={['/en/test']}>
              <Routes>
                <Route element={<KnowledgeLayout />}>
                  <Route path="*" element={<TestComponent />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </EventBusProvider>
        </QueryClientProvider>
      );

      expect(screen.getByText(/Token:/)).toBeInTheDocument();
    });

    it('should provide ApiClientProvider', async () => {
      const { default: KnowledgeLayout } = await import('@/app/[locale]/know/layout');

      const TestComponent = () => {
        const client = useApiClient();
        return <div>Client: {client ? 'present' : 'null'}</div>;
      };

      render(
        <QueryClientProvider client={queryClient}>
          <EventBusProvider>
            <MemoryRouter initialEntries={['/en/test']}>
              <Routes>
                <Route element={<KnowledgeLayout />}>
                  <Route path="*" element={<TestComponent />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </EventBusProvider>
        </QueryClientProvider>
      );

      expect(screen.getByText('Client: present')).toBeInTheDocument();
    });

    it('should work with EventBusProvider from global providers', async () => {
      const { default: KnowledgeLayout } = await import('@/app/[locale]/know/layout');

      const TestComponent = () => {
        const eventBus = useEventBus();
        return <div>EventBus: {eventBus ? 'present' : 'null'}</div>;
      };

      render(
        <QueryClientProvider client={queryClient}>
          <EventBusProvider>
            <MemoryRouter initialEntries={['/en/test']}>
              <Routes>
                <Route element={<KnowledgeLayout />}>
                  <Route path="*" element={<TestComponent />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </EventBusProvider>
        </QueryClientProvider>
      );

      expect(screen.getByText('EventBus: present')).toBeInTheDocument();
    });

    it('should render successfully with all providers', async () => {
      const { default: KnowledgeLayout } = await import('@/app/[locale]/know/layout');

      const TestComponent = () => {
        return (
          <div>
            <div>All Providers: yes</div>
            <div data-testid="knowledge-content">Knowledge content loaded</div>
          </div>
        );
      };

      render(
        <QueryClientProvider client={queryClient}>
          <EventBusProvider>
            <MemoryRouter initialEntries={['/en/test']}>
              <Routes>
                <Route element={<KnowledgeLayout />}>
                  <Route path="*" element={<TestComponent />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </EventBusProvider>
        </QueryClientProvider>
      );

      expect(screen.getByText('All Providers: yes')).toBeInTheDocument();
      expect(screen.getByTestId('knowledge-content')).toBeInTheDocument();
    });
  });
});
