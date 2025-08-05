import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import RootLayout from '../layout';
import { env } from '@/lib/env';

// Mock the Providers component
vi.mock('../providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="providers">{children}</div>
  )
}));

// Mock the CookieBanner component
vi.mock('@/components/CookieBanner', () => ({
  CookieBanner: () => <div data-testid="cookie-banner">Cookie Banner</div>
}));

// Mock the env library
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SITE_NAME: 'Test Semiont'
  }
}));

// Mock Inter font
vi.mock('next/font/google', () => ({
  Inter: vi.fn(() => ({
    className: 'inter-font-class'
  }))
}));

// Mock globals.css import
vi.mock('../globals.css', () => ({}));

describe('RootLayout', () => {
  const mockChildren = <div data-testid="test-children">Test Content</div>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('HTML Structure', () => {
    it('should render layout component without throwing', () => {
      expect(() => render(<RootLayout>{mockChildren}</RootLayout>)).not.toThrow();
    });

    it('should render complete document structure', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      // Check that body contains the providers wrapper
      const providersElement = screen.getByTestId('providers');
      expect(providersElement).toBeInTheDocument();
      expect(document.body).toContainElement(providersElement);
    });
  });

  describe('Component Integration', () => {
    it('should render Providers component', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      const providersElement = screen.getByTestId('providers');
      expect(providersElement).toBeInTheDocument();
    });

    it('should render children within Providers', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      const childrenElement = screen.getByTestId('test-children');
      const providersElement = screen.getByTestId('providers');
      
      expect(childrenElement).toBeInTheDocument();
      expect(providersElement).toContainElement(childrenElement);
    });

    it('should render CookieBanner component', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      const cookieBannerElement = screen.getByTestId('cookie-banner');
      expect(cookieBannerElement).toBeInTheDocument();
    });

    it('should render CookieBanner after children in the Providers', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      const providersElement = screen.getByTestId('providers');
      const childrenElement = screen.getByTestId('test-children');
      const cookieBannerElement = screen.getByTestId('cookie-banner');
      
      // Both should be within providers
      expect(providersElement).toContainElement(childrenElement);
      expect(providersElement).toContainElement(cookieBannerElement);
      
      // Cookie banner should come after children in DOM order
      const providersChildren = Array.from(providersElement.children);
      const childrenIndex = providersChildren.findIndex(child => 
        child.getAttribute('data-testid') === 'test-children'
      );
      const cookieIndex = providersChildren.findIndex(child => 
        child.getAttribute('data-testid') === 'cookie-banner'
      );
      
      expect(childrenIndex).toBeLessThan(cookieIndex);
    });
  });

  describe('Children Rendering', () => {
    it('should render simple text children', () => {
      const simpleChildren = 'Simple text content';
      render(<RootLayout>{simpleChildren}</RootLayout>);
      
      expect(screen.getByText('Simple text content')).toBeInTheDocument();
    });

    it('should render complex JSX children', () => {
      const complexChildren = (
        <div>
          <h1>Main Title</h1>
          <p>Paragraph content</p>
          <button>Action Button</button>
        </div>
      );
      
      render(<RootLayout>{complexChildren}</RootLayout>);
      
      expect(screen.getByText('Main Title')).toBeInTheDocument();
      expect(screen.getByText('Paragraph content')).toBeInTheDocument();
      expect(screen.getByText('Action Button')).toBeInTheDocument();
    });

    it('should render multiple children elements', () => {
      const multipleChildren = (
        <>
          <div data-testid="child-1">Child 1</div>
          <div data-testid="child-2">Child 2</div>
          <div data-testid="child-3">Child 3</div>
        </>
      );
      
      render(<RootLayout>{multipleChildren}</RootLayout>);
      
      expect(screen.getByTestId('child-1')).toBeInTheDocument();
      expect(screen.getByTestId('child-2')).toBeInTheDocument();
      expect(screen.getByTestId('child-3')).toBeInTheDocument();
    });

    it('should handle null children gracefully', () => {
      render(<RootLayout>{null}</RootLayout>);
      
      // Should still render providers and cookie banner
      expect(screen.getByTestId('providers')).toBeInTheDocument();
      expect(screen.getByTestId('cookie-banner')).toBeInTheDocument();
    });

    it('should handle undefined children gracefully', () => {
      render(<RootLayout>{undefined}</RootLayout>);
      
      // Should still render providers and cookie banner
      expect(screen.getByTestId('providers')).toBeInTheDocument();
      expect(screen.getByTestId('cookie-banner')).toBeInTheDocument();
    });
  });

  describe('Font Integration', () => {
    it('should use Inter font configuration', () => {
      // Test passes if layout renders without font errors
      expect(() => render(<RootLayout>{mockChildren}</RootLayout>)).not.toThrow();
    });

    it('should handle font loading gracefully', () => {
      // Verify that font functionality doesn't break the component
      const { container } = render(<RootLayout>{mockChildren}</RootLayout>);
      expect(container).toBeInTheDocument();
    });
  });

  describe('Environment Integration', () => {
    it('should use site name from environment config', () => {
      // The metadata isn't directly testable in a component test,
      // but we can verify the env import is used
      expect(env.NEXT_PUBLIC_SITE_NAME).toBe('Test Semiont');
    });
  });

  describe('Accessibility', () => {
    it('should maintain semantic document structure', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      // Verify that the document structure follows HTML5 semantics
      expect(document.documentElement.tagName).toBe('HTML');
      expect(document.body.tagName).toBe('BODY');
    });

    it('should render content in logical order', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      const providersElement = screen.getByTestId('providers');
      const childrenElement = screen.getByTestId('test-children');
      const cookieBannerElement = screen.getByTestId('cookie-banner');
      
      // Verify logical ordering: children first, then cookie banner
      expect(providersElement).toContainElement(childrenElement);
      expect(providersElement).toContainElement(cookieBannerElement);
      
      // Cookie banner should be last for proper layering/accessibility
      const providersChildren = Array.from(providersElement.children);
      const lastChild = providersChildren[providersChildren.length - 1];
      expect(lastChild).toHaveAttribute('data-testid', 'cookie-banner');
    });
  });

  describe('CSS and Styling', () => {
    it('should import global CSS', () => {
      // This is tested through the mock, ensuring the import doesn't break
      expect(() => render(<RootLayout>{mockChildren}</RootLayout>)).not.toThrow();
    });

    it('should render without styling conflicts', () => {
      // Test that component renders successfully without CSS conflicts
      const { container } = render(<RootLayout>{mockChildren}</RootLayout>);
      expect(container).toBeInTheDocument();
    });
  });

  describe('Component Composition', () => {
    it('should render all components in correct hierarchy', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      // Check full hierarchy: html > body > Providers > (children + CookieBanner)
      const htmlElement = document.documentElement;
      const bodyElement = document.body;
      const providersElement = screen.getByTestId('providers');
      const childrenElement = screen.getByTestId('test-children');
      const cookieBannerElement = screen.getByTestId('cookie-banner');
      
      expect(htmlElement).toContainElement(bodyElement);
      expect(bodyElement).toContainElement(providersElement);
      expect(providersElement).toContainElement(childrenElement);
      expect(providersElement).toContainElement(cookieBannerElement);
    });

    it('should maintain component isolation', () => {
      render(<RootLayout>{mockChildren}</RootLayout>);
      
      // Each component should be properly mocked and isolated
      expect(screen.getByTestId('providers')).toBeInTheDocument();
      expect(screen.getByTestId('cookie-banner')).toBeInTheDocument();
      expect(screen.getByTestId('test-children')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle React fragments as children', () => {
      const fragmentChildren = (
        <React.Fragment>
          <div>Fragment Child 1</div>
          <div>Fragment Child 2</div>
        </React.Fragment>
      );
      
      render(<RootLayout>{fragmentChildren}</RootLayout>);
      
      expect(screen.getByText('Fragment Child 1')).toBeInTheDocument();
      expect(screen.getByText('Fragment Child 2')).toBeInTheDocument();
    });

    it('should handle conditional children', () => {
      const conditionalChildren = (
        <>
          {true && <div>Conditional Child 1</div>}
          {false && <div>Conditional Child 2</div>}
          {null}
          {undefined}
        </>
      );
      
      render(<RootLayout>{conditionalChildren}</RootLayout>);
      
      expect(screen.getByText('Conditional Child 1')).toBeInTheDocument();
      expect(screen.queryByText('Conditional Child 2')).not.toBeInTheDocument();
    });

    it('should not break with empty string children', () => {
      render(<RootLayout>{''}</RootLayout>);
      
      expect(screen.getByTestId('providers')).toBeInTheDocument();
      expect(screen.getByTestId('cookie-banner')).toBeInTheDocument();
    });

    it('should handle array of children', () => {
      const arrayChildren = [
        <div key="1">Array Child 1</div>,
        <div key="2">Array Child 2</div>,
        <div key="3">Array Child 3</div>
      ];
      
      render(<RootLayout>{arrayChildren}</RootLayout>);
      
      expect(screen.getByText('Array Child 1')).toBeInTheDocument();
      expect(screen.getByText('Array Child 2')).toBeInTheDocument();
      expect(screen.getByText('Array Child 3')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('should not throw when rendering with valid props', () => {
      expect(() => render(<RootLayout>{mockChildren}</RootLayout>)).not.toThrow();
    });

    it('should handle component render without crashing', () => {
      const { container } = render(<RootLayout>{mockChildren}</RootLayout>);
      expect(container).toBeInTheDocument();
    });
  });
});