/**
 * LiveRegion - Accessibility Tests
 *
 * WCAG 2.1 AA compliance tests for LiveRegion component.
 * Tests ARIA live regions for dynamic content announcements.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { LiveRegionProvider, useLiveRegion } from '../LiveRegion';

// Extend expect with accessibility matchers
expect.extend(toHaveNoViolations);

// Test component that uses the live region
function TestComponent() {
  const { announce } = useLiveRegion();

  return (
    <div>
      <button onClick={() => announce('Test message', 'polite')}>
        Announce Polite
      </button>
      <button onClick={() => announce('Alert message', 'assertive')}>
        Announce Assertive
      </button>
    </div>
  );
}

describe('LiveRegion - Accessibility', () => {
  describe('WCAG 2.1 AA - Automated axe-core Tests', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 4.1.3 - Status Messages', () => {
    it('should have polite live region for status messages', () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const politeRegion = screen.getByRole('status');
      expect(politeRegion).toBeInTheDocument();
      expect(politeRegion).toHaveAttribute('aria-live', 'polite');
      expect(politeRegion).toHaveAttribute('aria-atomic', 'true');
    });

    it('should have assertive live region for alerts', () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const assertiveRegion = screen.getByRole('alert');
      expect(assertiveRegion).toBeInTheDocument();
      expect(assertiveRegion).toHaveAttribute('aria-live', 'assertive');
      expect(assertiveRegion).toHaveAttribute('aria-atomic', 'true');
    });

    it('should be visually hidden but accessible to screen readers', () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const politeRegion = screen.getByRole('status');
      const assertiveRegion = screen.getByRole('alert');

      // Should have screen reader only class
      expect(politeRegion).toHaveClass('semiont-sr-only');
      expect(assertiveRegion).toHaveClass('semiont-sr-only');
    });
  });

  describe('Dynamic Content Announcements', () => {
    it('should announce polite messages', async () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const politeButton = screen.getByText('Announce Polite');
      politeButton.click();

      await waitFor(() => {
        const politeRegion = screen.getByRole('status');
        expect(politeRegion).toHaveTextContent('Test message');
      });
    });

    it('should announce assertive messages', async () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const assertiveButton = screen.getByText('Announce Assertive');
      assertiveButton.click();

      await waitFor(() => {
        const assertiveRegion = screen.getByRole('alert');
        expect(assertiveRegion).toHaveTextContent('Alert message');
      });
    });

    it('should clear messages after timeout', async () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const politeButton = screen.getByText('Announce Polite');
      politeButton.click();

      const politeRegion = screen.getByRole('status');

      // Message should appear
      await waitFor(() => {
        expect(politeRegion).toHaveTextContent('Test message');
      });

      // Message should clear after 1 second
      await waitFor(() => {
        expect(politeRegion).toHaveTextContent('');
      }, { timeout: 1500 });
    });
  });

  describe('ARIA Attributes', () => {
    it('should have proper ARIA roles', () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      // Polite region uses role="status"
      expect(screen.getByRole('status')).toBeInTheDocument();

      // Assertive region uses role="alert"
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('should have aria-atomic for complete message replacement', () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const politeRegion = screen.getByRole('status');
      const assertiveRegion = screen.getByRole('alert');

      // aria-atomic ensures the entire message is announced
      expect(politeRegion).toHaveAttribute('aria-atomic', 'true');
      expect(assertiveRegion).toHaveAttribute('aria-atomic', 'true');
    });
  });

  describe('Multiple Live Regions', () => {
    it('should support both polite and assertive announcements simultaneously', () => {
      render(
        <LiveRegionProvider>
          <TestComponent />
        </LiveRegionProvider>
      );

      const politeRegion = screen.getByRole('status');
      const assertiveRegion = screen.getByRole('alert');

      // Both regions should exist independently
      expect(politeRegion).toBeInTheDocument();
      expect(assertiveRegion).toBeInTheDocument();

      // They should be separate elements
      expect(politeRegion).not.toBe(assertiveRegion);
    });
  });

  describe('Context Provider', () => {
    it('should provide announce function through context', () => {
      let announceFunction: any;

      function CaptureContext() {
        const { announce } = useLiveRegion();
        announceFunction = announce;
        return null;
      }

      render(
        <LiveRegionProvider>
          <CaptureContext />
        </LiveRegionProvider>
      );

      expect(announceFunction).toBeDefined();
      expect(typeof announceFunction).toBe('function');
    });

    it('should return no-op function when used outside provider', () => {
      function ComponentWithoutProvider() {
        const { announce } = useLiveRegion();

        return (
          <button onClick={() => announce('Test', 'polite')}>
            Test
          </button>
        );
      }

      // Should not throw error
      const { container } = render(<ComponentWithoutProvider />);
      const button = container.querySelector('button');

      // Clicking should not cause errors
      expect(() => button?.click()).not.toThrow();
    });
  });

  describe('Screen Reader Compatibility', () => {
    it('should not interfere with normal page content', async () => {
      const { container } = render(
        <LiveRegionProvider>
          <main>
            <h1>Page Title</h1>
            <p>Page content</p>
            <TestComponent />
          </main>
        </LiveRegionProvider>
      );

      // Live regions should not affect main content
      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
      expect(screen.getByText('Page content')).toBeInTheDocument();

      // axe should not report violations
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});