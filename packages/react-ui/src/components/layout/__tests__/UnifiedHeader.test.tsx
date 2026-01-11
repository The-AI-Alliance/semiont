import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { UnifiedHeader } from '../UnifiedHeader';

// Mock dependencies
vi.mock('../../branding/SemiontBranding', () => ({
  SemiontBranding: ({ t, size, showTagline, compactTagline }: any) => (
    <div data-testid="semiont-branding">
      Semiont {size} {showTagline && '- Tagline'} {compactTagline && '(compact)'}
    </div>
  ),
}));

vi.mock('../../navigation/NavigationMenu', () => ({
  NavigationMenu: ({ t, onItemClick }: any) => (
    <div data-testid="navigation-menu">
      <button onClick={onItemClick}>Menu Item</button>
      <span>{t('home')}</span>
    </div>
  ),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: true,
    isAdmin: false,
    isModerator: false,
  })),
}));

vi.mock('@/hooks/useUI', () => ({
  useDropdown: vi.fn(() => ({
    isOpen: false,
    toggle: vi.fn(),
    close: vi.fn(),
    dropdownRef: { current: null },
  })),
}));

import { useDropdown } from '@/hooks/useUI';

// Mock Link component
const MockLink = ({ href, children, ...props }: any) => (
  <a href={href} {...props}>{children}</a>
);

// Mock routes
const mockRoutes = {
  home: () => '/',
  about: () => '/about',
} as any;

// Mock translation functions
const mockT = (key: string) => `nav.${key}`;
const mockTHome = (key: string) => `home.${key}`;

describe('UnifiedHeader Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useDropdown).mockReturnValue({
      isOpen: false,
      toggle: vi.fn(),
      close: vi.fn(),
      dropdownRef: { current: null },
    });
  });

  describe('Rendering - Standalone Variant', () => {
    it('should render standalone variant with header element', () => {
      const { container } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="standalone"
        />
      );

      const header = container.querySelector('header');
      expect(header).toBeInTheDocument();
      expect(header).toHaveClass('bg-white', 'dark:bg-gray-900', 'shadow');
    });

    it('should render branding in standalone variant', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="standalone"
        />
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should default to standalone variant', () => {
      const { container } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        />
      );

      const header = container.querySelector('header');
      expect(header).toBeInTheDocument();
    });
  });

  describe('Rendering - Embedded Variant', () => {
    it('should render embedded variant without header element', () => {
      const { container } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="embedded"
        />
      );

      const header = container.querySelector('header');
      expect(header).not.toBeInTheDocument();
    });

    it('should render branding in embedded variant', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="embedded"
        />
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });
  });

  describe('Rendering - Floating Variant', () => {
    it('should render floating variant with fixed positioning', () => {
      const { container } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="floating"
        />
      );

      const floatingDiv = container.querySelector('.fixed');
      expect(floatingDiv).toBeInTheDocument();
      expect(floatingDiv).toHaveClass('top-0', 'left-0', 'w-64');
    });

    it('should render branding in floating variant', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="floating"
        />
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should not render floating variant when showBranding is false', () => {
      const { container } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="floating"
          showBranding={false}
        />
      );

      const floatingDiv = container.querySelector('.fixed');
      expect(floatingDiv).not.toBeInTheDocument();
    });
  });

  describe('Branding Display', () => {
    it('should show branding by default', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        />
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should hide branding when showBranding is false', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          showBranding={false}
        />
      );

      expect(screen.queryByTestId('semiont-branding')).not.toBeInTheDocument();
    });

    it('should render navigation button for branding', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        />
      );

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toBeInTheDocument();
    });
  });

  describe('Dropdown Menu', () => {
    it('should toggle dropdown when branding button clicked', () => {
      const mockToggle = vi.fn();
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: false,
        toggle: mockToggle,
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        />
      );

      const button = screen.getByLabelText('Navigation menu');
      fireEvent.click(button);

      expect(mockToggle).toHaveBeenCalledOnce();
    });

    it('should show dropdown menu when open and authenticated', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
                  isAuthenticated={true}
        />
      );

      expect(screen.getByTestId('navigation-menu')).toBeInTheDocument();
    });

    it('should not show dropdown menu when not authenticated', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
                  isAuthenticated={false}
        />
      );

      expect(screen.queryByTestId('navigation-menu')).not.toBeInTheDocument();
    });

    it('should not show dropdown menu when closed', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: false,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
                  isAuthenticated={true}
        />
      );

      expect(screen.queryByTestId('navigation-menu')).not.toBeInTheDocument();
    });

    it('should close dropdown when menu item clicked', () => {
      const mockClose = vi.fn();
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: mockClose,
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
                  isAuthenticated={true}
        />
      );

      const menuItem = screen.getByText('Menu Item');
      fireEvent.click(menuItem);

      expect(mockClose).toHaveBeenCalledOnce();
    });
  });

  describe('Props Handling', () => {
    it('should use custom branding link', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: false,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          brandingLink="/custom"
        />
      );

      // Should render branding with custom link
      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should default branding link to /', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        />
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should pass admin status to NavigationMenu', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
                  isAuthenticated={true}
          isAdmin={true}
        />
      );

      expect(screen.getByTestId('navigation-menu')).toBeInTheDocument();
    });

    it('should pass moderator status to NavigationMenu', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
                  isAuthenticated={true}
          isModerator={true}
        />
      );

      expect(screen.getByTestId('navigation-menu')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes on navigation button - standalone', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="standalone"
        />
      );

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).toHaveAttribute('aria-controls', 'nav-menu-dropdown-2');
      expect(button).toHaveAttribute('aria-haspopup', 'true');
      expect(button).toHaveAttribute('id', 'nav-menu-button-2');
    });

    it('should have proper ARIA attributes on navigation button - floating', () => {
      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="floating"
        />
      );

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).toHaveAttribute('aria-controls', 'nav-menu-dropdown-1');
      expect(button).toHaveAttribute('aria-haspopup', 'true');
      expect(button).toHaveAttribute('id', 'nav-menu-button-1');
    });

    it('should update aria-expanded when dropdown opens', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        />
      );

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toHaveAttribute('aria-expanded', 'true');
    });

    it('should have proper menu role attributes', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
                  isAuthenticated={true}
        />
      );

      const dropdown = screen.getByRole('menu');
      expect(dropdown).toHaveAttribute('aria-orientation', 'vertical');
      expect(dropdown).toHaveAttribute('aria-labelledby', 'nav-menu-button-2');
      expect(dropdown).toHaveAttribute('id', 'nav-menu-dropdown-2');
    });
  });

  describe('Styling', () => {
    it('should have proper standalone header styling', () => {
      const { container } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="standalone"
        />
      );

      const header = container.querySelector('header');
      expect(header).toHaveClass('bg-white', 'dark:bg-gray-900', 'shadow', 'border-b');
    });

    it('should have proper floating variant styling', () => {
      const { container } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="floating"
        />
      );

      const floatingDiv = container.querySelector('.fixed');
      expect(floatingDiv).toHaveClass(
        'top-0',
        'left-0',
        'w-64',
        'z-50',
        'bg-white',
        'dark:bg-gray-900'
      );
    });

    it('should have different layout classes for standalone vs embedded', () => {
      const { container: standaloneContainer } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="standalone"
        />
      );

      const { container: embeddedContainer } = render(
        <UnifiedHeader
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          variant="embedded"
        />
      );

      const standaloneContent = standaloneContainer.querySelector('.h-16');
      expect(standaloneContent).toBeInTheDocument();

      const embeddedContent = embeddedContainer.querySelector('.mb-8');
      expect(embeddedContent).toBeInTheDocument();
    });
  });
});
