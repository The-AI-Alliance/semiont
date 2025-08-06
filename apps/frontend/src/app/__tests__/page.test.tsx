import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import Home from '@/app/page';

// Mock all child components to isolate the Home page structure
vi.mock('@/components/Header', () => ({
  Header: () => <div data-testid="header">Header</div>
}));

vi.mock('@/components/GreetingSection', () => ({
  GreetingSection: () => <div data-testid="greeting-section">GreetingSection</div>
}));

vi.mock('@/components/FeatureCards', () => ({
  FeatureCards: () => <div data-testid="feature-cards">FeatureCards</div>
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
    
    // Check for screen reader heading
    const heroHeading = screen.getByLabelText(/semiont.*ai.*powered.*research.*platform/i);
    expect(heroHeading).toBeInTheDocument();
    
    // Check for main content heading (screen reader only)
    const srHeading = screen.getByText(/semiont.*ai.*powered.*research.*platform/i);
    expect(srHeading).toBeInTheDocument();
    expect(srHeading).toHaveClass('sr-only');
    
    // Check for subtitle
    const subtitle = screen.getByText(/make meaning from your data with ai.*powered research/i);
    expect(subtitle).toBeInTheDocument();
    expect(subtitle).toHaveClass('text-xl', 'text-gray-600', 'dark:text-gray-300');
  });

  it('should render all main components wrapped in error boundaries', () => {
    render(<Home />);
    
    // Check that all main components are rendered
    expect(screen.getByTestId('header')).toBeInTheDocument();
    expect(screen.getByTestId('greeting-section')).toBeInTheDocument();
    expect(screen.getByTestId('feature-cards')).toBeInTheDocument();
    expect(screen.getByTestId('status-display')).toBeInTheDocument();
    expect(screen.getByTestId('footer')).toBeInTheDocument();
    
    // Check that error boundaries are present
    const errorBoundaries = screen.getAllByTestId('error-boundary');
    expect(errorBoundaries).toHaveLength(4); // Header, Greeting, Features, Status
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
    const contentArea = screen.getByText(/make meaning from your data/i).closest('.text-center');
    expect(contentArea).toBeInTheDocument();
    expect(contentArea).toHaveClass('text-center', 'space-y-6');
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
    
    // Check heading hierarchy
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toBeInTheDocument();
    expect(h1).toHaveAttribute('id', 'hero-heading');
  });
});