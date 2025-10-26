import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import Home from '@/app/[locale]/page';

// Mock all child components to isolate the Home page structure
vi.mock('@/components/shared/UnifiedHeader', () => ({
  UnifiedHeader: () => <header data-testid="unified-header">Unified Header</header>
}));

vi.mock('@/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">User Menu</div>
}));

// Removed unused components: FeatureCards, AuthenticatedHome

vi.mock('@/components/SemiontBranding', () => ({
  SemiontBranding: ({ size, animated, className }: any) => (
    <div data-testid="semiont-branding" className={className}>
      <h2>Semiont</h2>
    </div>
  )
}));

vi.mock('@/components/StatusDisplay', () => ({
  StatusDisplay: () => <div data-testid="status-display">StatusDisplay</div>
}));

vi.mock('@/components/ErrorBoundary', () => ({
  AsyncErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  )
}));

vi.mock('@/components/Footer', () => ({
  Footer: () => <div data-testid="footer">Footer</div>
}));

describe('Home Page', () => {
  it('should render the main structure', () => {
    render(<Home />);
    
    // Check main container structure
    const mainContainer = screen.getByRole('main');
    expect(mainContainer).toBeInTheDocument();
    expect(mainContainer).toHaveClass('flex-1', 'flex', 'flex-col', 'items-center', 'justify-center', 'p-24');
  });

  it('should render the hero section with proper heading structure', () => {
    render(<Home />);
    
    // Check for screen reader heading (it exists but is sr-only)
    const srHeading = screen.getByText(/Semiont - AI-Powered Research Platform/i);
    expect(srHeading).toBeInTheDocument();
    expect(srHeading).toHaveClass('sr-only');
    expect(srHeading).toHaveAttribute('id', 'hero-heading');
    
    // Check for subtitle/tagline
    const subtitle = screen.getByText(/open-source.*future-proof.*framework/i);
    expect(subtitle).toBeInTheDocument();
    expect(subtitle).toHaveClass('text-xl', 'text-gray-600', 'dark:text-gray-300');
  });

  it('should render all main components', () => {
    render(<Home />);
    
    // Check that main components are rendered
    expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
    expect(screen.getByTestId('footer')).toBeInTheDocument();
    
    // Check for action buttons
    expect(screen.getByText('Learn More')).toBeInTheDocument();
    expect(screen.getByText('Sign Up')).toBeInTheDocument();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('should have proper semantic HTML structure', () => {
    render(<Home />);
    
    // Check for main role
    expect(screen.getByRole('main')).toBeInTheDocument();
    
    // Check for section with proper aria-labelledby
    const heroSection = screen.getByLabelText(/semiont.*ai.*powered.*research.*platform/i);
    expect(heroSection.tagName).toBe('SECTION');
    expect(heroSection).toHaveAttribute('aria-labelledby', 'hero-heading');
  });

  it('should have responsive design classes', () => {
    render(<Home />);
    
    const container = screen.getByRole('main').parentElement;
    expect(container).toHaveClass('flex', 'flex-col', 'min-h-screen');
    
    const innerContainer = screen.getByRole('main').firstElementChild;
    expect(innerContainer).toHaveClass('z-10', 'w-full', 'max-w-5xl');
  });

  it('should have proper content spacing and layout', () => {
    render(<Home />);

    // Check for text center and spacing on content area
    const contentArea = screen.getByText(/open-source.*future-proof/i).closest('.text-center');
    expect(contentArea).toBeInTheDocument();
    expect(contentArea).toHaveClass('text-center', 'space-y-8');
  });

  it('should render footer at the bottom', () => {
    render(<Home />);
    
    const footer = screen.getByTestId('footer');
    expect(footer).toBeInTheDocument();
    
    // Footer should be outside the main element
    const main = screen.getByRole('main');
    expect(main.contains(footer)).toBe(false);
  });

  it('should maintain accessibility features', () => {
    render(<Home />);
    
    // Check that main has proper role
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('role', 'main');
    
    // Check for the sr-only h1 heading
    const h1 = screen.getByText(/Semiont - AI-Powered Research Platform/i);
    expect(h1).toBeInTheDocument();
    expect(h1.tagName).toBe('H1');
    expect(h1).toHaveAttribute('id', 'hero-heading');
    expect(h1).toHaveClass('sr-only');
  });
});