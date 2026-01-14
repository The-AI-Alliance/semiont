import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { AdminNavigation } from '../AdminNavigation';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

// Mock @/i18n/routing to use the same mock as next/navigation
vi.mock('@/i18n/routing', async () => {
  const { usePathname } = await import('next/navigation');
  return {
    usePathname,
    Link: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
  };
});

// Mock Heroicons
vi.mock('@heroicons/react/24/outline', () => ({
  UsersIcon: ({ className }: { className?: string }) => (
    <svg data-testid="users-icon" className={className} />
  ),
  ShieldCheckIcon: ({ className }: { className?: string }) => (
    <svg data-testid="shield-check-icon" className={className} />
  ),
  CommandLineIcon: ({ className }: { className?: string }) => (
    <svg data-testid="command-line-icon" className={className} />
  ),
}));

describe('AdminNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic rendering', () => {
    beforeEach(() => {
      (usePathname as any).mockReturnValue('/admin');
    });

    it('should render navigation container with correct styling', () => {
      const { container } = render(<AdminNavigation />);

      const nav = container.querySelector('.p-4');
      expect(nav).toBeInTheDocument();
      expect(nav).toHaveClass('p-4');
    });

    // Removed "Back to Site" link test - this link no longer exists in the component

    it('should render administration section header', () => {
      render(<AdminNavigation />);

      expect(screen.getByText('Administration')).toBeInTheDocument();
      expect(screen.getByText('Administration')).toHaveClass('sidebar-navigation__title');
    });

    it('should render all navigation items', () => {
      render(<AdminNavigation />);

      // Users link
      const usersLink = screen.getByRole('link', { name: /users/i });
      expect(usersLink).toHaveAttribute('href', '/admin/users');
      expect(usersLink).toHaveAttribute('title', 'User management and permissions');
      expect(screen.getByTestId('users-icon')).toBeInTheDocument();

      // OAuth Settings link
      const securityLink = screen.getByRole('link', { name: /oauth settings/i });
      expect(securityLink).toHaveAttribute('href', '/admin/security');
      expect(securityLink).toHaveAttribute('title', 'View OAuth configuration');
      expect(screen.getByTestId('shield-check-icon')).toBeInTheDocument();
    });
  });

  describe('Active state handling', () => {
    it('should highlight active Users navigation item', () => {
      (usePathname as any).mockReturnValue('/admin/users');
      
      render(<AdminNavigation />);

      const usersLink = screen.getByRole('link', { name: /users/i });
      expect(usersLink).toHaveClass(
        'bg-blue-50',
        'dark:bg-blue-900/20',
        'text-blue-700',
        'dark:text-blue-300',
        'border-r-2',
        'border-blue-500'
      );

      const usersIcon = screen.getByTestId('users-icon');
      expect(usersIcon).toHaveClass('sidebar-navigation__icon', 'sidebar-navigation__icon--active');
    });

    it('should highlight active OAuth Settings navigation item', () => {
      (usePathname as any).mockReturnValue('/admin/security');
      
      render(<AdminNavigation />);

      const securityLink = screen.getByRole('link', { name: /oauth settings/i });
      expect(securityLink).toHaveClass(
        'bg-blue-50',
        'dark:bg-blue-900/20',
        'text-blue-700',
        'dark:text-blue-300',
        'border-r-2',
        'border-blue-500'
      );

      const securityIcon = screen.getByTestId('shield-check-icon');
      expect(securityIcon).toHaveClass('sidebar-navigation__icon', 'sidebar-navigation__icon--active');
    });

    it('should not highlight any item when on admin dashboard', () => {
      (usePathname as any).mockReturnValue('/admin');
      
      render(<AdminNavigation />);

      const usersLink = screen.getByRole('link', { name: /users/i });
      expect(usersLink).toHaveClass(
        'text-gray-700',
        'dark:text-gray-300',
        'hover:text-gray-900',
        'dark:hover:text-white',
        'hover:bg-gray-50',
        'dark:hover:bg-gray-800'
      );

      const securityLink = screen.getByRole('link', { name: /oauth settings/i });
      expect(securityLink).toHaveClass(
        'text-gray-700',
        'dark:text-gray-300',
        'hover:text-gray-900',
        'dark:hover:text-white',
        'hover:bg-gray-50',
        'dark:hover:bg-gray-800'
      );
    });

    it('should not highlight any item when on unrelated path', () => {
      (usePathname as any).mockReturnValue('/admin/some-other-page');
      
      render(<AdminNavigation />);

      const usersLink = screen.getByRole('link', { name: /users/i });
      const securityLink = screen.getByRole('link', { name: /oauth settings/i });

      // Both should be inactive
      expect(usersLink).not.toHaveClass('bg-blue-50');
      expect(securityLink).not.toHaveClass('bg-blue-50');
    });
  });

  describe('Icon styling', () => {
    beforeEach(() => {
      (usePathname as any).mockReturnValue('/admin');
    });

    it('should apply correct icon classes for inactive items', () => {
      render(<AdminNavigation />);

      const usersIcon = screen.getByTestId('users-icon');
      expect(usersIcon).toHaveClass('sidebar-navigation__icon', 'sidebar-navigation__icon--inactive');

      const securityIcon = screen.getByTestId('shield-check-icon');
      expect(securityIcon).toHaveClass('sidebar-navigation__icon', 'sidebar-navigation__icon--inactive');
    });

    // Removed home icon test - home icon no longer exists in the component
  });

  describe('Layout and structure', () => {
    beforeEach(() => {
      (usePathname as any).mockReturnValue('/admin');
    });

    it('should have proper navigation container structure', () => {
      const { container } = render(<AdminNavigation />);

      const navContainer = container.querySelector('.p-4');
      expect(navContainer).toBeInTheDocument();

      const itemsContainer = navContainer?.querySelector('.sidebar-navigation__items');
      expect(itemsContainer).toBeInTheDocument();
    });

    // Removed separator test - separator no longer exists in the component

    it('should render all links with proper button-like styling', () => {
      render(<AdminNavigation />);

      const links = screen.getAllByRole('link');
      
      links.forEach(link => {
        expect(link).toHaveClass('group', 'flex', 'items-center', 'px-3', 'py-2', 'text-sm', 'font-medium');
      });
    });
  });

  describe('Dark mode support', () => {
    beforeEach(() => {
      (usePathname as any).mockReturnValue('/admin');
    });

    it('should have dark mode classes for navigation container', () => {
      render(<AdminNavigation />);

      // AdminNavigation no longer wraps in nav element - it's just content
      // The parent LeftSidebar handles dark mode styling
      const adminHeader = screen.getByText('Administration');
      expect(adminHeader).toHaveClass('sidebar-navigation__title');
    });

    // Removed separator dark mode test - separator no longer exists in the component

    it('should have dark mode classes for administration header', () => {
      render(<AdminNavigation />);

      const adminHeader = screen.getByText('Administration');
      expect(adminHeader).toHaveClass('sidebar-navigation__title');
    });

    it('should have dark mode hover states for inactive links', () => {
      render(<AdminNavigation />);

      const usersLink = screen.getByRole('link', { name: /users/i });
      expect(usersLink).toHaveClass('dark:text-gray-300', 'dark:hover:text-white', 'dark:hover:bg-gray-800');
    });
  });

  describe('Accessibility', () => {
    beforeEach(() => {
      (usePathname as any).mockReturnValue('/admin');
    });

    it('should use semantic nav element', () => {
      // AdminNavigation no longer wraps in nav element - it's just content
      // The parent LeftSidebar provides the structural wrapper
      const { container } = render(<AdminNavigation />);

      const navContainer = container.querySelector('.p-4');
      expect(navContainer).toBeInTheDocument();
      expect(navContainer?.tagName).toBe('DIV');
    });

    it('should have title attributes for tooltips', () => {
      render(<AdminNavigation />);

      const usersLink = screen.getByRole('link', { name: /users/i });
      expect(usersLink).toHaveAttribute('title', 'User management and permissions');

      const securityLink = screen.getByRole('link', { name: /oauth settings/i });
      expect(securityLink).toHaveAttribute('title', 'View OAuth configuration');
    });

    it('should maintain focus and hover states', () => {
      render(<AdminNavigation />);

      const links = screen.getAllByRole('link');
      links.forEach(link => {
        expect(link).toHaveClass('transition-colors');
      });
    });

    it('should have proper link text for screen readers', () => {
      render(<AdminNavigation />);

      expect(screen.getByRole('link', { name: /users/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /oauth settings/i })).toBeInTheDocument();
    });
  });

  describe('Navigation configuration', () => {
    it('should handle dynamic pathname changes', () => {
      const { rerender } = render(<AdminNavigation />);

      // Start with users page active
      (usePathname as any).mockReturnValue('/admin/users');
      rerender(<AdminNavigation />);
      
      let usersLink = screen.getByRole('link', { name: /users/i });
      expect(usersLink).toHaveClass('bg-blue-50');

      // Change to security page active
      (usePathname as any).mockReturnValue('/admin/security');
      rerender(<AdminNavigation />);
      
      usersLink = screen.getByRole('link', { name: /users/i });
      const securityLink = screen.getByRole('link', { name: /oauth settings/i });
      
      expect(usersLink).not.toHaveClass('bg-blue-50');
      expect(securityLink).toHaveClass('bg-blue-50');
    });
  });
});