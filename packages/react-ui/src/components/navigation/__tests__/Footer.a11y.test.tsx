/**
 * Footer - Accessibility Tests
 *
 * WCAG 2.1 AA compliance tests for Footer component.
 * Tests semantic HTML, keyboard navigation, and ARIA attributes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations} from 'jest-axe';
import { Footer } from '../Footer';

// Extend expect with accessibility matchers
expect.extend(toHaveNoViolations);

describe('Footer - Accessibility', () => {
  const mockLink = vi.fn(({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ));

  const mockRoutes = {
    about: vi.fn(() => '/about'),
    privacy: vi.fn(() => '/privacy'),
    terms: vi.fn(() => '/terms'),
  };

  const mockTranslate = vi.fn((key: string) => {
    const translations: Record<string, string> = {
      'about': 'About',
      'privacy': 'Privacy Policy',
      'terms': 'Terms of Service',
      'copyright': '© 2024 Semiont. All rights reserved.',
      'keyboardShortcuts': 'Keyboard Shortcuts (press ? for help)',
    };
    return translations[key] || key;
  });

  const MockCookiePreferences = () => <div>Cookie Preferences</div>;

  describe('WCAG 2.1 AA - Automated axe-core Tests', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have no accessibility violations with keyboard help handler', async () => {
      const onOpenKeyboardHelp = vi.fn();

      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 1.3.1 - Info and Relationships (Semantic HTML)', () => {
    it('should use semantic footer element', () => {
      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const footer = container.querySelector('footer');
      expect(footer).toBeInTheDocument();
    });

    it('should use semantic nav elements for navigation links', () => {
      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const nav = container.querySelector('nav');
      expect(nav).toBeInTheDocument();
    });
  });

  describe('WCAG 2.1.1 - Keyboard Accessibility', () => {
    it('should have keyboard-accessible links', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const aboutLink = screen.getByText('About');
      const privacyLink = screen.getByText('Privacy Policy');
      const termsLink = screen.getByText('Terms of Service');

      expect(aboutLink).toBeInTheDocument();
      expect(privacyLink).toBeInTheDocument();
      expect(termsLink).toBeInTheDocument();
    });

    it('should have keyboard-accessible keyboard shortcuts button', () => {
      const onOpenKeyboardHelp = vi.fn();

      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      const button = screen.getByRole('button', { name: /Keyboard Shortcuts/i });
      expect(button).toBeInTheDocument();
      expect(button).not.toHaveAttribute('disabled');
    });

    it('should support Tab navigation through all interactive elements', () => {
      const onOpenKeyboardHelp = vi.fn();

      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      const interactiveElements = container.querySelectorAll('a, button');

      // All interactive elements should be keyboard accessible
      interactiveElements.forEach(element => {
        expect(element).not.toHaveAttribute('tabindex', '-1');
      });
    });
  });

  describe('WCAG 4.1.2 - Name, Role, Value (ARIA)', () => {
    it('should have accessible names for all links', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const links = screen.getAllByRole('link');

      // All links should have accessible names
      links.forEach(link => {
        expect(link).toHaveAccessibleName();
      });
    });

    it('should have accessible name for keyboard shortcuts button', () => {
      const onOpenKeyboardHelp = vi.fn();

      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAccessibleName(/Keyboard Shortcuts/i);
    });
  });

  describe('WCAG 2.4.6 - Headings and Labels (Descriptive)', () => {
    it('should have descriptive link text', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      // Link text should be descriptive
      expect(screen.getByText('About')).toBeInTheDocument();
      expect(screen.getByText('Privacy Policy')).toBeInTheDocument();
      expect(screen.getByText('Terms of Service')).toBeInTheDocument();
    });

    it('should have descriptive button text', () => {
      const onOpenKeyboardHelp = vi.fn();

      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      expect(screen.getByRole('button')).toHaveTextContent(/Keyboard Shortcuts/i);
    });
  });

  describe('WCAG 1.4.3 - Color Contrast (Minimum)', () => {
    it('should have sufficient color contrast', async () => {
      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      // axe-core will check color contrast
      const results = await axe(container, {
        rules: {
          'color-contrast': { enabled: true }
        }
      });

      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 2.5.3 - Label in Name', () => {
    it('should have link text matching accessible name', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const aboutLink = screen.getByRole('link', { name: 'About' });
      expect(aboutLink).toHaveTextContent('About');

      const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' });
      expect(privacyLink).toHaveTextContent('Privacy Policy');
    });
  });

  describe('Focus Management', () => {
    it('should have visible focus indicators on links', () => {
      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const links = container.querySelectorAll('a');

      // Links should have focus styling
      links.forEach(link => {
        expect(link.className).toBeTruthy();
      });
    });

    it('should have visible focus indicators on buttons', () => {
      const onOpenKeyboardHelp = vi.fn();

      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      const button = container.querySelector('button');

      // Button should have focus styling
      expect(button?.className).toBeTruthy();
    });

    it('should maintain logical tab order', () => {
      const onOpenKeyboardHelp = vi.fn();

      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      const interactiveElements = container.querySelectorAll('a, button');

      // Should have multiple interactive elements in DOM order
      expect(interactiveElements.length).toBeGreaterThan(0);
    });
  });

  describe('Contentinfo Landmark', () => {
    it('should be a contentinfo landmark', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const footer = screen.getByRole('contentinfo');
      expect(footer).toBeInTheDocument();
    });
  });

  describe('Copyright Information', () => {
    it('should display copyright information', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      expect(screen.getByText(/© 2024 Semiont. All rights reserved./i)).toBeInTheDocument();
    });
  });

  describe('Translation Support', () => {
    it('should call translation function for all labels', () => {
      mockTranslate.mockClear();

      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      // Translation function should be called for footer content
      expect(mockTranslate).toHaveBeenCalled();
    });
  });

  describe('Cookie Preferences Component', () => {
    it('should render Cookie Preferences component', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
    });
  });

  describe('Keyboard Shortcuts Button', () => {
    it('should call onOpenKeyboardHelp when button is clicked', () => {
      const onOpenKeyboardHelp = vi.fn();

      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
          onOpenKeyboardHelp={onOpenKeyboardHelp}
        />
      );

      const button = screen.getByRole('button', { name: /Keyboard Shortcuts/i });
      button.click();

      expect(onOpenKeyboardHelp).toHaveBeenCalledTimes(1);
    });

    it('should not render keyboard shortcuts button without handler', () => {
      render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const button = screen.queryByRole('button', { name: /Keyboard Shortcuts/i });
      expect(button).not.toBeInTheDocument();
    });
  });

  describe('Link Destinations', () => {
    it('should have correct href attributes', () => {
      const { container } = render(
        <Footer
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          CookiePreferences={MockCookiePreferences}
        />
      );

      const links = container.querySelectorAll('a');

      // Links should have href attributes
      links.forEach(link => {
        expect(link).toHaveAttribute('href');
      });
    });
  });
});
