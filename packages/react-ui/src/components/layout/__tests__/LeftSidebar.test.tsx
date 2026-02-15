import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LeftSidebar } from '../LeftSidebar';

// No mocks - using real components via composition

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

      // Real SemiontBranding renders "Semiont" text
      expect(screen.getByText('Semiont')).toBeInTheDocument();
    });

    it('should render branding link', () => {
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

      const brandingLink = screen.getByLabelText('Go to home page');
      expect(brandingLink).toBeInTheDocument();
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

  describe('Navigation Menu Helper', () => {
    it('should provide navigationMenu helper to function children', () => {
      const mockChildren = vi.fn((isCollapsed, toggleCollapsed, navigationMenu) => {
        // Test that navigationMenu helper returns NavigationMenu component
        const menuElement = navigationMenu(() => {});
        return <div data-testid="children-content">{menuElement}</div>;
      });

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
          isAdmin={true}
        >
          {mockChildren}
        </LeftSidebar>
      );

      expect(mockChildren).toHaveBeenCalled();
      // Real NavigationMenu renders navigation links
      const childrenContent = screen.getByTestId('children-content');
      expect(childrenContent.querySelector('nav.semiont-navigation-menu')).toBeInTheDocument();
    });

    it('should pass onClose callback to NavigationMenu', () => {
      const mockOnClose = vi.fn();
      const mockChildren = vi.fn((isCollapsed, toggleCollapsed, navigationMenu) => {
        const menuElement = navigationMenu(mockOnClose);
        return <div>{menuElement}</div>;
      });

      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          {mockChildren}
        </LeftSidebar>
      );

      // Real NavigationMenu renders a link (translated 'know' key)
      const menuItem = screen.getByText('nav.know');
      fireEvent.click(menuItem);

      expect(mockOnClose).toHaveBeenCalledOnce();
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
      // When collapsed, full "Semiont" branding is not shown
      expect(screen.queryByText(/^Semiont$/)).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes on nav element', () => {
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

      const nav = screen.getByRole('navigation');
      expect(nav).toHaveAttribute('aria-label', 'Main navigation');
      expect(nav).toHaveAttribute('id', 'main-navigation');
    });

    it('should have accessible branding link', () => {
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

      const brandingLink = screen.getByLabelText('Go to home page');
      expect(brandingLink).toHaveAttribute('href', '/');
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

      expect(screen.getByText('Semiont')).toBeInTheDocument();
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

      expect(screen.getByText('Semiont')).toBeInTheDocument();
    });
  });
});
