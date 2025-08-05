import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { AdminHeader } from '../AdminHeader';
import { useAuth } from '@/hooks/useAuth';
import { env } from '@/lib/env';

// Mock dependencies
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SITE_NAME: 'Test Site',
  },
}));

vi.mock('@/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">User Menu</div>,
}));

const mockPush = vi.fn();
const mockRouter = { push: mockPush };

describe('AdminHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as any).mockReturnValue(mockRouter);
  });

  describe('Loading state', () => {
    it('should render loading state when auth is loading', () => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: false,
        isLoading: true,
      });

      render(<AdminHeader />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.getByText('Loading...')).toHaveClass('animate-pulse', 'text-gray-400');
      
      // Should render header structure
      const header = screen.getByRole('banner');
      expect(header).toHaveClass('bg-white', 'dark:bg-gray-900', 'shadow');
    });

    it('should not redirect when loading', () => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: false,
        isLoading: true,
      });

      render(<AdminHeader />);

      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('Authentication redirect', () => {
    it('should redirect to signin when not authenticated and not loading', async () => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

      render(<AdminHeader />);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/auth/signin');
      });
    });

    it('should return null when not authenticated and not loading', () => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

      const { container } = render(<AdminHeader />);
      
      // Component should render nothing
      expect(container.firstChild).toBeNull();
    });

    it('should not redirect when authenticated', () => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });

      render(<AdminHeader />);

      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('Authenticated state', () => {
    beforeEach(() => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });
    });

    it('should render the full header when authenticated', () => {
      render(<AdminHeader />);

      // Check header structure
      const header = screen.getByRole('banner');
      expect(header).toHaveClass('bg-white', 'dark:bg-gray-900', 'shadow');

      // Check site name link
      const siteLink = screen.getByRole('link', { name: env.NEXT_PUBLIC_SITE_NAME });
      expect(siteLink).toHaveAttribute('href', '/');
      expect(siteLink).toHaveClass('text-xl', 'font-semibold');

      // Check breadcrumb separator
      expect(screen.getByText('/')).toBeInTheDocument();

      // Check admin dashboard text
      expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Admin Dashboard')).toHaveClass('text-lg', 'font-medium');

      // Check user menu is rendered
      expect(screen.getByTestId('user-menu')).toBeInTheDocument();
    });

    it('should have correct styling classes for site name link', () => {
      render(<AdminHeader />);

      const siteLink = screen.getByRole('link', { name: env.NEXT_PUBLIC_SITE_NAME });
      expect(siteLink).toHaveClass(
        'text-xl',
        'font-semibold',
        'text-gray-900',
        'dark:text-white',
        'hover:text-blue-600',
        'dark:hover:text-blue-400',
        'transition-colors'
      );
    });

    it('should have correct layout structure', () => {
      render(<AdminHeader />);

      // Check responsive container
      const container = screen.getByRole('banner').querySelector('.max-w-7xl');
      expect(container).toHaveClass('max-w-7xl', 'mx-auto', 'px-4', 'sm:px-6', 'lg:px-8');

      // Check flex layout
      const flexContainer = container?.querySelector('.flex');
      expect(flexContainer).toHaveClass('flex', 'justify-between', 'items-center', 'h-16');
    });

    it('should render breadcrumb with correct styling', () => {
      render(<AdminHeader />);

      const separator = screen.getByText('/');
      expect(separator).toHaveClass('text-gray-400', 'dark:text-gray-500');

      const adminText = screen.getByText('Admin Dashboard');
      expect(adminText).toHaveClass('text-lg', 'font-medium', 'text-gray-700', 'dark:text-gray-300');
    });
  });

  describe('Dark mode support', () => {
    beforeEach(() => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });
    });

    it('should have dark mode classes for header', () => {
      render(<AdminHeader />);

      const header = screen.getByRole('banner');
      expect(header).toHaveClass('dark:bg-gray-900', 'dark:border-gray-700');
    });

    it('should have dark mode classes for site link', () => {
      render(<AdminHeader />);

      const siteLink = screen.getByRole('link', { name: env.NEXT_PUBLIC_SITE_NAME });
      expect(siteLink).toHaveClass('dark:text-white', 'dark:hover:text-blue-400');
    });

    it('should have dark mode classes for breadcrumb elements', () => {
      render(<AdminHeader />);

      const separator = screen.getByText('/');
      expect(separator).toHaveClass('dark:text-gray-500');

      const adminText = screen.getByText('Admin Dashboard');
      expect(adminText).toHaveClass('dark:text-gray-300');
    });
  });

  describe('Accessibility', () => {
    beforeEach(() => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });
    });

    it('should have proper semantic header element', () => {
      render(<AdminHeader />);

      const header = screen.getByRole('banner');
      expect(header.tagName).toBe('HEADER');
    });

    it('should have accessible link to home page', () => {
      render(<AdminHeader />);

      const homeLink = screen.getByRole('link', { name: env.NEXT_PUBLIC_SITE_NAME });
      expect(homeLink).toBeInTheDocument();
      expect(homeLink).toHaveAttribute('href', '/');
    });

    it('should maintain focus styles for interactive elements', () => {
      render(<AdminHeader />);

      const siteLink = screen.getByRole('link', { name: env.NEXT_PUBLIC_SITE_NAME });
      expect(siteLink).toHaveClass('hover:text-blue-600');
    });
  });

  describe('Integration with environment config', () => {
    it('should use site name from environment config', () => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });

      render(<AdminHeader />);

      expect(screen.getByText(env.NEXT_PUBLIC_SITE_NAME)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: env.NEXT_PUBLIC_SITE_NAME })).toBeInTheDocument();
    });
  });

  describe('Edge cases', () => {
    it('should handle undefined auth states gracefully', () => {
      (useAuth as any).mockReturnValue({
        isAuthenticated: undefined,
        isLoading: undefined,
      });

      const { container } = render(<AdminHeader />);
      
      // Should not crash and should render nothing when auth state is undefined
      expect(container.firstChild).toBeNull();
    });

    it('should handle auth state changes', async () => {
      const { rerender } = render(<AdminHeader />);

      // Start with loading
      (useAuth as any).mockReturnValue({
        isAuthenticated: false,
        isLoading: true,
      });
      rerender(<AdminHeader />);
      expect(screen.getByText('Loading...')).toBeInTheDocument();

      // Change to authenticated
      (useAuth as any).mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });
      rerender(<AdminHeader />);
      expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    });
  });
});