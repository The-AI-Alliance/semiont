import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { UnifiedHeader } from '../UnifiedHeader';

// Mock the UserMenu component
vi.mock('../../UserMenu', () => ({
  UserMenu: ({ showAuthLinks }: { showAuthLinks?: boolean }) => (
    <div data-testid="user-menu" data-show-auth-links={showAuthLinks}>
      User Menu Mock
    </div>
  )
}));

// Mock the SemiontBranding component
vi.mock('../../SemiontBranding', () => ({
  SemiontBranding: ({ size, showTagline, animated, compactTagline, className }: any) => (
    <div 
      className={className} 
      data-testid="semiont-branding"
      data-size={size}
      data-show-tagline={showTagline}
      data-animated={animated}
      data-compact-tagline={compactTagline}
    >
      <h1>Semiont</h1>
      {showTagline && <div>tagline</div>}
    </div>
  )
}));

describe('UnifiedHeader Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Standalone Variant', () => {
    it('should render as a full header element with styling', () => {
      render(<UnifiedHeader variant="standalone" />);
      
      const header = screen.getByRole('banner');
      expect(header).toBeInTheDocument();
      expect(header).toHaveClass('bg-white', 'dark:bg-gray-900', 'shadow', 'border-b');
    });

    it('should include responsive padding', () => {
      render(<UnifiedHeader variant="standalone" />);
      
      const container = screen.getByRole('banner').firstChild;
      expect(container).toHaveClass('pl-4', 'pr-1', 'sm:pl-6', 'sm:pr-1', 'lg:pl-8', 'lg:pr-1');
    });

    it('should use space-x-4 for user menu spacing', () => {
      render(<UnifiedHeader variant="standalone" />);
      
      const userMenuContainer = screen.getByTestId('user-menu').parentElement;
      expect(userMenuContainer).toHaveClass('flex', 'items-center', 'space-x-4');
    });
  });

  describe('Embedded Variant', () => {
    it('should render as a div without header wrapper', () => {
      const { container } = render(<UnifiedHeader variant="embedded" />);
      
      const header = screen.queryByRole('banner');
      expect(header).not.toBeInTheDocument();
      
      // Should just be a div with content
      const content = container.firstChild;
      expect(content?.nodeName).toBe('DIV');
    });

    it('should use text-right for user menu positioning', () => {
      render(<UnifiedHeader variant="embedded" />);
      
      const userMenuContainer = screen.getByTestId('user-menu').parentElement;
      expect(userMenuContainer).toHaveClass('text-right', 'relative');
    });

  });

  describe('Branding Props', () => {
    it('should show branding by default', () => {
      render(<UnifiedHeader />);
      
      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should hide branding when showBranding is false', () => {
      render(<UnifiedHeader showBranding={false} />);
      
      expect(screen.queryByTestId('semiont-branding')).not.toBeInTheDocument();
      // Should render an empty div as placeholder
      const firstChild = screen.getByTestId('user-menu').parentElement?.parentElement?.firstChild;
      expect(firstChild?.nodeName).toBe('DIV');
      expect(firstChild?.textContent).toBe('');
    });

    it('should link to home by default', () => {
      render(<UnifiedHeader />);
      
      const link = screen.getByTestId('semiont-branding').closest('a');
      expect(link).toHaveAttribute('href', '/');
    });

    it('should use custom brandingLink when provided', () => {
      render(<UnifiedHeader brandingLink="/know" />);
      
      const link = screen.getByTestId('semiont-branding').closest('a');
      expect(link).toHaveAttribute('href', '/know');
    });

    it('should pass correct props to SemiontBranding', () => {
      render(<UnifiedHeader />);
      
      const branding = screen.getByTestId('semiont-branding');
      expect(branding).toHaveAttribute('data-size', 'sm');
      expect(branding).toHaveAttribute('data-show-tagline', 'true');
      expect(branding).toHaveAttribute('data-animated', 'false');
      expect(branding).toHaveAttribute('data-compact-tagline', 'true');
      expect(branding).toHaveClass('py-1');
    });
  });

  describe('Auth Links Props', () => {
    it('should show auth links by default', () => {
      render(<UnifiedHeader />);
      
      const userMenu = screen.getByTestId('user-menu');
      expect(userMenu).toHaveAttribute('data-show-auth-links', 'true');
    });

    it('should hide auth links when showAuthLinks is false', () => {
      render(<UnifiedHeader showAuthLinks={false} />);
      
      const userMenu = screen.getByTestId('user-menu');
      expect(userMenu).toHaveAttribute('data-show-auth-links', 'false');
    });
  });

  describe('Layout and Styling', () => {
    it('should apply hover effect to branding link', () => {
      render(<UnifiedHeader />);
      
      const link = screen.getByTestId('semiont-branding').closest('a');
      expect(link).toHaveClass('hover:opacity-80', 'transition-opacity');
    });
  });

  describe('Default Props', () => {
    it('should default to standalone variant', () => {
      render(<UnifiedHeader />);
      
      const header = screen.getByRole('banner');
      expect(header).toBeInTheDocument();
    });

    it('should default to showing branding', () => {
      render(<UnifiedHeader />);
      
      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    });

    it('should default to showing auth links', () => {
      render(<UnifiedHeader />);
      
      const userMenu = screen.getByTestId('user-menu');
      expect(userMenu).toHaveAttribute('data-show-auth-links', 'true');
    });

    it('should default brandingLink to /', () => {
      render(<UnifiedHeader />);
      
      const link = screen.getByTestId('semiont-branding').closest('a');
      expect(link).toHaveAttribute('href', '/');
    });
  });

  describe('Component Integration', () => {
    it('should render UserMenu in correct position for standalone', () => {
      render(<UnifiedHeader variant="standalone" />);
      
      const userMenu = screen.getByTestId('user-menu');
      const container = userMenu.parentElement?.parentElement;
      
      // UserMenu should be in the second child (after branding)
      expect(container?.lastChild).toBe(userMenu.parentElement);
    });

    it('should render UserMenu in correct position for embedded', () => {
      render(<UnifiedHeader variant="embedded" />);
      
      const userMenu = screen.getByTestId('user-menu');
      const container = userMenu.parentElement?.parentElement;
      
      // UserMenu should be in the second child (after branding)
      expect(container?.lastChild).toBe(userMenu.parentElement);
    });
  });

  describe('Dark Mode Support', () => {
    it('should include dark mode classes for standalone', () => {
      render(<UnifiedHeader variant="standalone" />);
      
      const header = screen.getByRole('banner');
      expect(header).toHaveClass('dark:bg-gray-900');
      expect(header).toHaveClass('dark:border-gray-700');
    });
  });

  describe('Accessibility', () => {
    it('should use semantic header element for standalone', () => {
      render(<UnifiedHeader variant="standalone" />);
      
      const header = screen.getByRole('banner');
      expect(header.tagName).toBe('HEADER');
    });

    it('should maintain proper heading hierarchy', () => {
      const { container } = render(<UnifiedHeader />);
      
      const h1Elements = container.querySelectorAll('h1');
      expect(h1Elements).toHaveLength(1);
    });

    it('should have accessible link for branding', () => {
      render(<UnifiedHeader />);
      
      const link = screen.getByTestId('semiont-branding').closest('a');
      expect(link).toBeInTheDocument();
      // Link should be keyboard accessible by default
      expect(link?.tagName).toBe('A');
    });
  });

  describe('Edge Cases', () => {
    it('should handle all props being set', () => {
      render(
        <UnifiedHeader 
          showBranding={true}
          showAuthLinks={false}
          brandingLink="/custom"
          variant="embedded"
        />
      );
      
      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
      const link = screen.getByTestId('semiont-branding').closest('a');
      expect(link).toHaveAttribute('href', '/custom');
      
      const userMenu = screen.getByTestId('user-menu');
      expect(userMenu).toHaveAttribute('data-show-auth-links', 'false');
      
      // Should not have header wrapper for embedded
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    });

    it('should render correctly with minimal props', () => {
      const { container } = render(<UnifiedHeader />);
      
      expect(container.firstChild).toBeInTheDocument();
      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
      expect(screen.getByTestId('user-menu')).toBeInTheDocument();
    });
  });
});