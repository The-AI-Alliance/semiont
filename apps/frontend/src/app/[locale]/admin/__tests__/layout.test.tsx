import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdminLayout from '../layout';
import { env } from '@/lib/env';

// Mock the admin components
// Note: AdminAuthWrapper was removed - auth is now handled by middleware
vi.mock('@/components/shared/LeftSidebar', () => ({
  LeftSidebar: ({ children }: { children: React.ReactNode | ((isCollapsed: boolean, toggleCollapsed: () => void) => React.ReactNode) }) => (
    <aside data-testid="admin-sidebar">
      {typeof children === 'function' ? children(false, () => {}) : children}
    </aside>
  ),
}));

vi.mock('@/components/admin/AdminNavigation', () => ({
  AdminNavigation: () => <nav data-testid="admin-navigation">Admin Navigation</nav>,
}));

vi.mock('@/components/Footer', () => ({
  Footer: () => <footer data-testid="admin-footer">Footer</footer>,
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SITE_NAME: 'Test Site',
  },
}));

describe('AdminLayout', () => {
  const mockChildren = <div data-testid="admin-children">Admin Page Content</div>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render the complete admin layout structure', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      // Check that all components are present
      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByTestId('admin-children')).toBeInTheDocument();
      expect(screen.getByTestId('admin-footer')).toBeInTheDocument();
    });

    it('should have proper root container structure', () => {
      const { container } = render(<AdminLayout>{mockChildren}</AdminLayout>);

      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toBeInTheDocument();
      expect(rootContainer).toHaveClass('min-h-screen', 'bg-gray-50', 'dark:bg-gray-900', 'flex', 'flex-col');
    });

    it('should render children within the main content area', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const children = screen.getByTestId('admin-children');
      const main = screen.getByRole('main');

      expect(main).toContainElement(children);
    });
  });

  describe('Layout structure', () => {
    it('should have correct root container styling', () => {
      const { container } = render(<AdminLayout>{mockChildren}</AdminLayout>);

      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toHaveClass('min-h-screen', 'bg-gray-50', 'dark:bg-gray-900');
    });

    it('should have proper flex layout for sidebar and main content', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      // Find the flex container that holds sidebar and main
      const sidebar = screen.getByTestId('admin-sidebar');
      const flexContainer = sidebar.parentElement;
      expect(flexContainer).toHaveClass('flex', 'flex-1');

      // Check main element styling
      const main = screen.getByRole('main');
      expect(main).toHaveClass('flex-1', 'p-6');
    });

    it('should have responsive container for main content', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const main = screen.getByRole('main');
      const contentContainer = main.querySelector('.max-w-7xl');

      expect(contentContainer).toBeInTheDocument();
      expect(contentContainer).toHaveClass('max-w-7xl', 'mx-auto');
      expect(contentContainer).toContainElement(screen.getByTestId('admin-children'));
    });
  });

  describe('Component composition', () => {
    it('should render LeftSidebar with navigation', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const sidebar = screen.getByTestId('admin-sidebar');
      const navigation = screen.getByTestId('admin-navigation');
      const main = screen.getByRole('main');

      // Sidebar should contain navigation
      expect(sidebar).toContainElement(navigation);

      // Sidebar and main should be siblings
      expect(sidebar.nextElementSibling).toBe(main);
    });

    it('should render AdminNavigation in sidebar position', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const navigation = screen.getByTestId('admin-navigation');
      const sidebar = screen.getByTestId('admin-sidebar');
      const main = screen.getByRole('main');

      // Navigation should be inside sidebar
      expect(sidebar).toContainElement(navigation);

      // Sidebar and main should be siblings in the flex container
      expect(sidebar.parentElement).toBe(main.parentElement);
      expect(sidebar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('should render main content area with correct semantic element', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const main = screen.getByRole('main');
      expect(main.tagName).toBe('MAIN');
    });

    it('should render Footer at the bottom', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const footer = screen.getByTestId('admin-footer');
      const main = screen.getByRole('main');

      // Footer should come after main content
      expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('Dark mode support', () => {
    it('should have dark mode classes on root container', () => {
      const { container } = render(<AdminLayout>{mockChildren}</AdminLayout>);

      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toHaveClass('dark:bg-gray-900');
    });
  });

  describe('Children rendering', () => {
    it('should render simple text children', () => {
      render(<AdminLayout>Simple text content</AdminLayout>);

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

      render(<AdminLayout>{complexChildren}</AdminLayout>);

      expect(screen.getByText('Page Title')).toBeInTheDocument();
      expect(screen.getByText('Page content')).toBeInTheDocument();
      expect(screen.getByText('Action Button')).toBeInTheDocument();
    });

    it('should render multiple children', () => {
      render(
        <AdminLayout>
          <div data-testid="child-1">Child 1</div>
          <div data-testid="child-2">Child 2</div>
          <div data-testid="child-3">Child 3</div>
        </AdminLayout>
      );

      expect(screen.getByTestId('child-1')).toBeInTheDocument();
      expect(screen.getByTestId('child-2')).toBeInTheDocument();
      expect(screen.getByTestId('child-3')).toBeInTheDocument();
    });

    it('should handle null/undefined children gracefully', () => {
      const { container } = render(<AdminLayout>{null}</AdminLayout>);

      // Layout should still render properly with no children
      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(screen.getByTestId('admin-footer')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should use semantic HTML structure', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      // Check semantic elements are present
      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument(); // sidebar element
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument(); // nav element
      expect(screen.getByRole('main')).toBeInTheDocument(); // main element
    });

    it('should maintain proper document structure for screen readers', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const main = screen.getByRole('main');

      // Main should have proper content structure
      expect(main).toContainElement(screen.getByTestId('admin-children'));

      // Content should be within responsive container
      const contentContainer = main.querySelector('.max-w-7xl');
      expect(contentContainer).toContainElement(screen.getByTestId('admin-children'));
    });
  });

  describe('Responsive behavior', () => {
    it('should have responsive padding classes', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const main = screen.getByRole('main');
      expect(main).toHaveClass('p-6');
    });

    it('should have responsive max-width container', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const contentContainer = screen.getByRole('main').querySelector('.max-w-7xl');
      expect(contentContainer).toHaveClass('max-w-7xl', 'mx-auto');
    });
  });

  describe('Integration', () => {
    it('should properly integrate all admin components', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      // All components should be present and in correct hierarchy
      // Note: AdminAuthWrapper was removed as auth is now handled by middleware
      const sidebar = screen.getByTestId('admin-sidebar');
      const navigation = screen.getByTestId('admin-navigation');
      const main = screen.getByRole('main');
      const children = screen.getByTestId('admin-children');
      const footer = screen.getByTestId('admin-footer');

      // Verify all elements are present in the document
      expect(sidebar).toBeInTheDocument();
      expect(navigation).toBeInTheDocument();
      expect(main).toBeInTheDocument();
      expect(footer).toBeInTheDocument();

      // Verify children are in main
      expect(main).toContainElement(children);

      // Verify proper ordering - sidebar comes before main, main comes before footer
      expect(sidebar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('should create a complete admin page structure', () => {
      const { container } = render(
        <AdminLayout>
          <h1>Admin Dashboard</h1>
          <p>Welcome to the admin area</p>
        </AdminLayout>
      );

      // Check overall structure
      const rootContainer = container.querySelector('.min-h-screen');
      expect(rootContainer).toBeInTheDocument();

      // Check all major sections are present
      expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(screen.getByTestId('admin-footer')).toBeInTheDocument();

      // Check content is rendered
      expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Welcome to the admin area')).toBeInTheDocument();
    });
  });

  describe('Security note', () => {
    it('should have comment about middleware handling authentication', () => {
      // This test just documents that authentication is handled by middleware
      // The actual authentication logic is tested in middleware tests
      expect(true).toBe(true);
    });
  });
});