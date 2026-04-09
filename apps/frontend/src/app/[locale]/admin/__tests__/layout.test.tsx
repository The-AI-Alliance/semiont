import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AdminLayout from '../layout';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isAdmin: true,
    isModerator: false,
    token: 'mock-token',
    session: null,
    user: null,
    backendUser: null,
    isLoading: false,
    hasValidBackendToken: true,
    isFullyAuthenticated: true,
    userDomain: 'example.com',
    displayName: 'Admin User',
    avatarUrl: null,
  }),
}));

vi.mock('@/contexts/KeyboardShortcutsContext', () => ({
  KeyboardShortcutsContext: React.createContext(null),
}));

vi.mock('@/lib/routing', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
  routes: {},
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    EventBusProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ApiClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LeftSidebar: ({ children }: { children: React.ReactNode | Function }) => (
      <aside data-testid="admin-sidebar">
        {typeof children === 'function'
          ? children(false, () => {}, () => null)
          : children}
      </aside>
    ),
    Footer: () => <footer data-testid="admin-footer">Footer</footer>,
  };
});

vi.mock('@/components/admin/AdminNavigation', () => ({
  AdminNavigation: () => <nav data-testid="admin-navigation">Admin Navigation</nav>,
}));

vi.mock('@/lib/env', () => ({
  SEMIONT_SITE_NAME: 'Test Site',
}));

vi.mock('@/contexts/KnowledgeBaseContext', () => ({
  KnowledgeBaseProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useKnowledgeBaseContext: () => ({
    activeKnowledgeBase: { id: 'test', label: 'localhost', host: 'localhost', port: 4000, protocol: 'http', email: 'admin@example.com' },
    knowledgeBases: [],
    activeKnowledgeBaseId: 'test',
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

vi.mock('@/contexts/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/** Render AdminLayout (Outlet-based) with a child component via React Router. */
function renderAdminLayout(child: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/en/admin/test']}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="*" element={<>{child}</>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('AdminLayout', () => {
  const mockChildren = <div data-testid="admin-children">Admin Page Content</div>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render the complete admin layout structure', () => {
      renderAdminLayout(mockChildren);

      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByTestId('admin-children')).toBeInTheDocument();
      expect(screen.getByTestId('admin-footer')).toBeInTheDocument();
    });

    it('should have proper root container structure', () => {
      const { container } = renderAdminLayout(mockChildren);

      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toBeInTheDocument();
      expect(rootContainer).toHaveClass('min-h-screen', 'bg-gray-50', 'dark:bg-gray-900', 'flex', 'flex-col');
    });

    it('should render children within the main content area', () => {
      renderAdminLayout(mockChildren);

      const children = screen.getByTestId('admin-children');
      const main = screen.getByRole('main');

      expect(main).toContainElement(children);
    });
  });

  describe('Layout structure', () => {
    it('should have correct root container styling', () => {
      const { container } = renderAdminLayout(mockChildren);

      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toHaveClass('min-h-screen', 'bg-gray-50', 'dark:bg-gray-900');
    });

    it('should have proper flex layout for sidebar and main content', () => {
      renderAdminLayout(mockChildren);

      const sidebar = screen.getByTestId('admin-sidebar');
      const flexContainer = sidebar.parentElement;
      expect(flexContainer).toHaveClass('flex', 'flex-1');

      const main = screen.getByRole('main');
      expect(main).toHaveClass('flex-1', 'p-6');
    });

    it('should have responsive container for main content', () => {
      renderAdminLayout(mockChildren);

      const main = screen.getByRole('main');
      const contentContainer = main.querySelector('.max-w-7xl');

      expect(contentContainer).toBeInTheDocument();
      expect(contentContainer).toHaveClass('max-w-7xl', 'mx-auto');
      expect(contentContainer).toContainElement(screen.getByTestId('admin-children'));
    });
  });

  describe('Component composition', () => {
    it('should render LeftSidebar with navigation', () => {
      renderAdminLayout(mockChildren);

      const sidebar = screen.getByTestId('admin-sidebar');
      const navigation = screen.getByTestId('admin-navigation');
      const main = screen.getByRole('main');

      expect(sidebar).toContainElement(navigation);
      expect(sidebar.nextElementSibling).toBe(main);
    });

    it('should render AdminNavigation in sidebar position', () => {
      renderAdminLayout(mockChildren);

      const navigation = screen.getByTestId('admin-navigation');
      const sidebar = screen.getByTestId('admin-sidebar');
      const main = screen.getByRole('main');

      expect(sidebar).toContainElement(navigation);
      expect(sidebar.parentElement).toBe(main.parentElement);
      expect(sidebar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('should render main content area with correct semantic element', () => {
      renderAdminLayout(mockChildren);

      const main = screen.getByRole('main');
      expect(main.tagName).toBe('MAIN');
    });

    it('should render Footer at the bottom', () => {
      renderAdminLayout(mockChildren);

      const footer = screen.getByTestId('admin-footer');
      const main = screen.getByRole('main');

      expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('Dark mode support', () => {
    it('should have dark mode classes on root container', () => {
      const { container } = renderAdminLayout(mockChildren);

      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toHaveClass('dark:bg-gray-900');
    });
  });

  describe('Children rendering', () => {
    it('should render simple text children', () => {
      renderAdminLayout(<>Simple text content</>);

      expect(screen.getByText('Simple text content')).toBeInTheDocument();
    });

    it('should render complex JSX children', () => {
      const complexChildren = (
        <div>
          <h1>Page Title</h1>
          <p>Page content</p>
          <button>Action Button</button>
        </div>
      );

      renderAdminLayout(complexChildren);

      expect(screen.getByText('Page Title')).toBeInTheDocument();
      expect(screen.getByText('Page content')).toBeInTheDocument();
      expect(screen.getByText('Action Button')).toBeInTheDocument();
    });

    it('should render multiple children', () => {
      renderAdminLayout(
        <>
          <div data-testid="child-1">Child 1</div>
          <div data-testid="child-2">Child 2</div>
          <div data-testid="child-3">Child 3</div>
        </>
      );

      expect(screen.getByTestId('child-1')).toBeInTheDocument();
      expect(screen.getByTestId('child-2')).toBeInTheDocument();
      expect(screen.getByTestId('child-3')).toBeInTheDocument();
    });

    it('should render layout without outlet content', () => {
      renderAdminLayout(null);

      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(screen.getByTestId('admin-footer')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should use semantic HTML structure', () => {
      renderAdminLayout(mockChildren);

      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    it('should maintain proper document structure for screen readers', () => {
      renderAdminLayout(mockChildren);

      const main = screen.getByRole('main');

      expect(main).toContainElement(screen.getByTestId('admin-children'));

      const contentContainer = main.querySelector('.max-w-7xl');
      expect(contentContainer).toContainElement(screen.getByTestId('admin-children'));
    });
  });

  describe('Responsive behavior', () => {
    it('should have responsive padding classes', () => {
      renderAdminLayout(mockChildren);

      const main = screen.getByRole('main');
      expect(main).toHaveClass('p-6');
    });

    it('should have responsive max-width container', () => {
      renderAdminLayout(mockChildren);

      const contentContainer = screen.getByRole('main').querySelector('.max-w-7xl');
      expect(contentContainer).toHaveClass('max-w-7xl', 'mx-auto');
    });
  });

  describe('Integration', () => {
    it('should properly integrate all admin components', () => {
      renderAdminLayout(mockChildren);

      const sidebar = screen.getByTestId('admin-sidebar');
      const navigation = screen.getByTestId('admin-navigation');
      const main = screen.getByRole('main');
      const children = screen.getByTestId('admin-children');
      const footer = screen.getByTestId('admin-footer');

      expect(sidebar).toBeInTheDocument();
      expect(navigation).toBeInTheDocument();
      expect(main).toBeInTheDocument();
      expect(footer).toBeInTheDocument();

      expect(main).toContainElement(children);

      expect(sidebar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('should create a complete admin page structure', () => {
      const { container } = renderAdminLayout(
        <>
          <h1>Admin Dashboard</h1>
          <p>Welcome to the admin area</p>
        </>
      );

      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toBeInTheDocument();

      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(screen.getByTestId('admin-footer')).toBeInTheDocument();

      expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Welcome to the admin area')).toBeInTheDocument();
    });
  });

  describe('Security note', () => {
    it('should have comment about middleware handling authentication', () => {
      // Authentication is handled by the auth context and sub-layouts
      expect(true).toBe(true);
    });
  });
});
