import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdminLayout from '../layout';
import { env } from '@/lib/env';

// Mock all the admin components
vi.mock('@/components/admin/AdminAuthWrapper', () => ({
  AdminAuthWrapper: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="admin-auth-wrapper">{children}</div>
  ),
}));

vi.mock('@/components/shared/UnifiedHeader', () => ({
  UnifiedHeader: () => <header data-testid="admin-header">Unified Header</header>,
}));

vi.mock('@/components/admin/AdminNavigation', () => ({
  AdminNavigation: () => <nav data-testid="admin-navigation">Admin Navigation</nav>,
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
      expect(screen.getByTestId('admin-auth-wrapper')).toBeInTheDocument();
      expect(screen.getByTestId('admin-header')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByTestId('admin-children')).toBeInTheDocument();
    });

    it('should wrap entire layout in AdminAuthWrapper', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const authWrapper = screen.getByTestId('admin-auth-wrapper');
      
      // AuthWrapper should contain all other elements
      expect(authWrapper).toContainElement(screen.getByTestId('admin-header'));
      expect(authWrapper).toContainElement(screen.getByTestId('admin-navigation'));
      expect(authWrapper).toContainElement(screen.getByTestId('admin-children'));
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
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const rootContainer = screen.getByTestId('admin-auth-wrapper').firstChild as HTMLElement;
      expect(rootContainer).toHaveClass('min-h-screen', 'bg-gray-50', 'dark:bg-gray-900');
    });

    it('should have proper flex layout for sidebar and main content', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      // Find the flex container that holds navigation and main
      const flexContainer = screen.getByTestId('admin-navigation').parentElement;
      expect(flexContainer).toHaveClass('flex');

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
    it('should render AdminHeader at the top level', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const header = screen.getByTestId('admin-header');
      const navigation = screen.getByTestId('admin-navigation');
      const main = screen.getByRole('main');

      // Header should come before the flex container with nav and main
      expect(header.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(header.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('should render AdminNavigation in sidebar position', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const navigation = screen.getByTestId('admin-navigation');
      const main = screen.getByRole('main');

      // Navigation and main should be siblings in the flex container
      expect(navigation.parentElement).toBe(main.parentElement);
      expect(navigation.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('should render main content area with correct semantic element', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const main = screen.getByRole('main');
      expect(main.tagName).toBe('MAIN');
    });
  });

  describe('Dark mode support', () => {
    it('should have dark mode classes on root container', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      const rootContainer = screen.getByTestId('admin-auth-wrapper').firstChild as HTMLElement;
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
      expect(screen.getByTestId('admin-auth-wrapper')).toBeInTheDocument();
      expect(screen.getByTestId('admin-header')).toBeInTheDocument();
      expect(screen.getByTestId('admin-navigation')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should use semantic HTML structure', () => {
      render(<AdminLayout>{mockChildren}</AdminLayout>);

      // Check semantic elements are present
      expect(screen.getByTestId('admin-header')).toBeInTheDocument(); // header element
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
      const authWrapper = screen.getByTestId('admin-auth-wrapper');
      const header = screen.getByTestId('admin-header');
      const navigation = screen.getByTestId('admin-navigation');
      const main = screen.getByRole('main');
      const children = screen.getByTestId('admin-children');

      // Verify hierarchy
      expect(authWrapper).toContainElement(header);
      expect(authWrapper).toContainElement(navigation);
      expect(authWrapper).toContainElement(main);
      expect(main).toContainElement(children);
    });

    it('should work with different types of admin pages', () => {
      const dashboardContent = <div data-testid="dashboard">Dashboard Content</div>;
      const { rerender } = render(<AdminLayout>{dashboardContent}</AdminLayout>);
      
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();

      const usersContent = <div data-testid="users-page">Users Management</div>;
      rerender(<AdminLayout>{usersContent}</AdminLayout>);
      
      expect(screen.getByTestId('users-page')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
    });
  });
});