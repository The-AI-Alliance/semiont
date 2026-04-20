/**
 * Layout Provider Tests
 *
 * These tests ensure that all layouts provide the required context providers
 * for their child components. This prevents regressions where providers are
 * accidentally omitted, causing runtime errors.
 *
 * Context: We had bugs where admin/moderate layouts were missing providers,
 * causing "must be used within" errors. The event bus now lives inside
 * `SemiontSession` (owned by `SemiontProvider`), so there is no separate
 * EventBus provider to check for. The auth token is owned by
 * `SemiontSession`, so there is no separate AuthToken provider to check for.
 */

import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import {
  useApiClient,
  SemiontProvider,
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

// Mock @semiont/react-ui to provide a fake KnowledgeBaseSession state and
// passthrough versions of the heavy contexts/hooks the layouts touch.
const TEST_KB = { id: 'test', label: 'localhost', host: 'localhost', port: 4000, protocol: 'http' as const, email: 'admin@example.com' };

const { stubBrowser } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs');
  const stubClient = {
    actor: { state$: { subscribe: () => ({ unsubscribe: () => {} }) } },
  };
  const TEST_KB = { id: 'test', label: 'localhost', host: 'localhost', port: 4000, protocol: 'http', email: 'admin@example.com' };
  const stubUser$ = new BehaviorSubject({ isAdmin: true, isModerator: true });
  const stubToken$ = new BehaviorSubject('test-token');
  const stubSession = {
    client: stubClient,
    kb: TEST_KB,
    user$: stubUser$,
    token$: stubToken$,
    refresh: async () => null,
  };
  const stubActiveSession$ = new BehaviorSubject(stubSession);
  const stubKbs$ = new BehaviorSubject([TEST_KB]);
  const stubActiveKbId$ = new BehaviorSubject(TEST_KB.id);
  return {
    stubBrowser: {
      activeSession$: stubActiveSession$,
      kbs$: stubKbs$,
      activeKbId$: stubActiveKbId$,
      setActiveKb: async () => {},
    },
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    kbBackendUrl: (kb: any) => `${kb.protocol}://${kb.host}:${kb.port}`,
    getKbSessionStatus: () => 'authenticated',
    useSemiont: () => stubBrowser,
  };
});

vi.mock('@/hooks/useOpenResourcesManager', () => ({
  useOpenResourcesManager: () => ({
    openResources: [],
    openResource: vi.fn(),
    closeResource: vi.fn(),
    setActiveResource: vi.fn(),
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

// Mock AuthShell as a passthrough — these tests verify layout-level providers,
// not the auth shell itself
vi.mock('@/contexts/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));


// Wrap the rendered tree in a SemiontProvider whose browser is the hoisted
// stub, so layouts that touch useSemiont internally don't throw.
function renderWithSemiont(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<SemiontProvider browser={stubBrowser as any}>{ui}</SemiontProvider>);
}

describe('Layout Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Admin Layout', () => {
    it('should provide ApiClientProvider', async () => {
      const { default: AdminLayout } = await import('@/app/[locale]/admin/layout');

      const TestComponent = () => {
        const semiont = useApiClient();
        return <div>Client: {semiont ? 'present' : 'null'}</div>;
      };

      renderWithSemiont(
        <MemoryRouter initialEntries={['/en/test']}>
          <Routes>
            <Route element={<AdminLayout />}>
              <Route path="*" element={<TestComponent />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );
      expect(screen.getByText('Client: present')).toBeInTheDocument();
    });
  });

  describe('Moderate Layout', () => {
    it('should provide ApiClientProvider', async () => {
      const { default: ModerateLayout } = await import('@/app/[locale]/moderate/layout');

      const TestComponent = () => {
        const semiont = useApiClient();
        return <div>Client: {semiont ? 'present' : 'null'}</div>;
      };

      renderWithSemiont(
        <MemoryRouter initialEntries={['/en/test']}>
          <Routes>
            <Route element={<ModerateLayout />}>
              <Route path="*" element={<TestComponent />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );
      expect(screen.getByText('Client: present')).toBeInTheDocument();
    });
  });

  describe('Knowledge Layout', () => {
    it('should provide ApiClientProvider', async () => {
      const { default: KnowledgeLayout } = await import('@/app/[locale]/know/layout');

      const TestComponent = () => {
        const semiont = useApiClient();
        return <div>Client: {semiont ? 'present' : 'null'}</div>;
      };

      renderWithSemiont(
        <MemoryRouter initialEntries={['/en/test']}>
          <Routes>
            <Route element={<KnowledgeLayout />}>
              <Route path="*" element={<TestComponent />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      expect(screen.getByText('Client: present')).toBeInTheDocument();
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

      renderWithSemiont(
        <MemoryRouter initialEntries={['/en/test']}>
          <Routes>
            <Route element={<KnowledgeLayout />}>
              <Route path="*" element={<TestComponent />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      expect(screen.getByText('All Providers: yes')).toBeInTheDocument();
      expect(screen.getByTestId('knowledge-content')).toBeInTheDocument();
    });
  });
});
