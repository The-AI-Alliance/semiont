import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { UnifiedHeader } from '../UnifiedHeader';

// Mock useAuth and useDropdown hooks
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    isAdmin: false,
    isModerator: false,
  }),
}));

vi.mock('@/hooks/useUI', () => ({
  useDropdown: () => ({
    isOpen: false,
    toggle: vi.fn(),
    close: vi.fn(),
    dropdownRef: { current: null },
  }),
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
      expect(container).toHaveClass('px-4', 'sm:px-6', 'lg:px-8');
    });

    it('should render navigation menu button', () => {
      render(<UnifiedHeader variant="standalone" />);

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toBeInTheDocument();
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

    it('should render branding and navigation button', () => {
      render(<UnifiedHeader variant="embedded" />);

      expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
      expect(screen.getByLabelText('Navigation menu')).toBeInTheDocument();
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

    it('should have accessible navigation button', () => {
      render(<UnifiedHeader />);

      const button = screen.getByLabelText('Navigation menu');
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-haspopup', 'true');
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
