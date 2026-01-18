import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LeftSidebar } from '../LeftSidebar';

// Mock dependencies
vi.mock('../../navigation/NavigationMenu', () => ({
  NavigationMenu: ({ t, onItemClick }: any) => (
    <div data-testid="navigation-menu">
      <button onClick={onItemClick}>Menu Item</button>
      <span>{t('home')}</span>
    </div>
  ),
}));

vi.mock('../../branding/SemiontBranding', () => ({
  SemiontBranding: ({ t, size, showTagline }: any) => (
    <div data-testid="semiont-branding">
      <span>Semiont {size}</span>
      {showTagline && <span>Tagline</span>}
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

// Mock translation function
const mockT = (key: string) => `nav.${key}`;
const mockTHome = (key: string) => `home.${key}`;

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

describe('LeftSidebar Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    vi.mocked(useDropdown).mockReturnValue({
      isOpen: false,
      toggle: vi.fn(),
      close: vi.fn(),
      dropdownRef: { current: null },
    });
  });

  describe('Rendering', () => {
    it('should render with required props', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Sidebar Content</div>
        </LeftSidebar>
      );

      expect(screen.getByText('Sidebar Content')).toBeInTheDocument();
    });

    it('should render branding when expanded', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should render navigation button', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toBeInTheDocument();
    });
  });

  describe('Collapse/Expand Functionality', () => {
    it('should start expanded by default', () => {
      const { container } = render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={true}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const aside = container.querySelector('aside');
      expect(aside).toHaveClass('semiont-left-sidebar');
      expect(aside).toHaveAttribute('data-collapsed', 'false');
    });

    it('should render function as children with collapse state', () => {
      const mockChildren = vi.fn((isCollapsed, toggleCollapsed) => (
        <div>
          <span data-testid="collapsed-state">{isCollapsed ? 'collapsed' : 'expanded'}</span>
          <button onClick={toggleCollapsed}>Toggle</button>
        </div>
      ));

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={true}
        >
          {mockChildren}
        </LeftSidebar>
      );

      expect(mockChildren).toHaveBeenCalled();
      expect(screen.getByTestId('collapsed-state')).toHaveTextContent('expanded');
    });

    it('should load collapsed state from localStorage', () => {
      localStorageMock.setItem('testStorageKey', 'true');

      const { container } = render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={true}
          storageKey="testStorageKey"
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const aside = container.querySelector('aside');
      expect(aside).toHaveClass('semiont-left-sidebar');
      expect(aside).toHaveAttribute('data-collapsed', 'true');
    });

    it('should save collapsed state to localStorage', () => {
      const mockChildren = vi.fn((isCollapsed, toggleCollapsed) => (
        <button onClick={toggleCollapsed} data-testid="toggle-btn">Toggle</button>
      ));

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={true}
          storageKey="customKey"
        >
          {mockChildren}
        </LeftSidebar>
      );

      const toggleButton = screen.getByTestId('toggle-btn');
      fireEvent.click(toggleButton);

      expect(localStorageMock.getItem('customKey')).toBe('true');
    });

    it('should not collapse when collapsible is false', () => {
      const mockChildren = vi.fn((isCollapsed, toggleCollapsed) => (
        <button onClick={toggleCollapsed} data-testid="toggle-btn">Toggle</button>
      ));

      const { container } = render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={false}
        >
          {mockChildren}
        </LeftSidebar>
      );

      const toggleButton = screen.getByTestId('toggle-btn');
      fireEvent.click(toggleButton);

      const aside = container.querySelector('aside');
      expect(aside).toHaveClass('semiont-left-sidebar');
      expect(aside).toHaveAttribute('data-collapsed', 'false'); // Still expanded
    });

    it('should use default storage key', () => {
      const mockChildren = vi.fn((isCollapsed, toggleCollapsed) => (
        <button onClick={toggleCollapsed} data-testid="toggle-btn">Toggle</button>
      ));

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={true}
        >
          {mockChildren}
        </LeftSidebar>
      );

      const toggleButton = screen.getByTestId('toggle-btn');
      fireEvent.click(toggleButton);

      expect(localStorageMock.getItem('leftSidebarCollapsed')).toBe('true');
    });
  });

  describe('Dropdown Menu', () => {
    it('should toggle dropdown when button clicked', () => {
      const mockToggle = vi.fn();
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: false,
        toggle: mockToggle,
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
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
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          isAuthenticated={true}
        >
          <div>Content</div>
        </LeftSidebar>
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
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          isAuthenticated={false}
        >
          <div>Content</div>
        </LeftSidebar>
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
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          isAuthenticated={true}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const menuItem = screen.getByText('Menu Item');
      fireEvent.click(menuItem);

      expect(mockClose).toHaveBeenCalledOnce();
    });
  });

  describe('Styling and Layout', () => {
    it('should have proper sidebar styling', () => {
      const { container } = render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const aside = container.querySelector('aside');
      expect(aside).toHaveClass('semiont-left-sidebar');
    });

    it('should apply transition classes', () => {
      const { container } = render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={true}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const aside = container.querySelector('aside');
      expect(aside).toHaveClass('semiont-left-sidebar');
    });

    it('should show "S" when collapsed', () => {
      localStorageMock.setItem('leftSidebarCollapsed', 'true');

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          collapsible={true}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      expect(screen.getByText('S')).toBeInTheDocument();
      expect(screen.queryByTestId('semiont-branding')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes on button', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).toHaveAttribute('aria-controls', 'sidebar-nav-dropdown');
      expect(button).toHaveAttribute('aria-haspopup', 'true');
      expect(button).toHaveAttribute('id', 'sidebar-nav-button');
    });

    it('should update aria-expanded when dropdown opens', () => {
      vi.mocked(useDropdown).mockReturnValue({
        isOpen: true,
        toggle: vi.fn(),
        close: vi.fn(),
        dropdownRef: { current: null },
      });

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
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
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          isAuthenticated={true}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const dropdown = screen.getByRole('menu');
      expect(dropdown).toHaveAttribute('aria-orientation', 'vertical');
      expect(dropdown).toHaveAttribute('aria-labelledby', 'sidebar-nav-button');
      expect(dropdown).toHaveAttribute('id', 'sidebar-nav-dropdown');
    });
  });

  describe('Props Handling', () => {
    it('should use custom branding link', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          brandingLink="/custom"
        >
          <div>Content</div>
        </LeftSidebar>
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should default branding link to /', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });
  });
});
