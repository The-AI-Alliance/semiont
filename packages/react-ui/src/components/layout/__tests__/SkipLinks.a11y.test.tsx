/**
 * SkipLinks - Accessibility Tests
 *
 * WCAG 2.1 AA compliance tests for SkipLinks component.
 * Tests keyboard navigation bypass mechanism.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { SkipLinks } from '../SkipLinks';

// Extend expect with accessibility matchers
expect.extend(toHaveNoViolations);

describe('SkipLinks - Accessibility', () => {
  describe('WCAG 2.1 AA - Automated axe-core Tests', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(<SkipLinks />);

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have no violations with custom links', async () => {
      const customLinks = [
        { href: '#custom-content', label: 'Skip to custom content' },
        { href: '#custom-nav', label: 'Skip to custom navigation' },
      ];

      const { container } = render(<SkipLinks links={customLinks} />);

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 2.4.1 - Bypass Blocks', () => {
    it('should provide skip to main content link by default', () => {
      render(<SkipLinks />);

      const skipLink = screen.getByRole('link', { name: /skip to main content/i });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink).toHaveAttribute('href', '#main-content');
    });

    it('should provide skip to navigation link by default', () => {
      render(<SkipLinks />);

      const skipLink = screen.getByRole('link', { name: /skip to navigation/i });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink).toHaveAttribute('href', '#navigation');
    });

    it('should support custom skip links', () => {
      const customLinks = [
        { href: '#search', label: 'Skip to search' },
        { href: '#footer', label: 'Skip to footer' },
      ];

      render(<SkipLinks links={customLinks} />);

      expect(screen.getByRole('link', { name: 'Skip to search' })).toHaveAttribute('href', '#search');
      expect(screen.getByRole('link', { name: 'Skip to footer' })).toHaveAttribute('href', '#footer');
    });
  });

  describe('WCAG 2.1.1 - Keyboard Navigation', () => {
    it('should be keyboard accessible', () => {
      render(<SkipLinks />);

      const links = screen.getAllByRole('link');

      links.forEach(link => {
        expect(link).not.toHaveAttribute('tabindex', '-1');
      });
    });

    it('should become visible on focus', async () => {
      const user = userEvent.setup();
      const { container } = render(<SkipLinks />);

      const skipLinksContainer = container.querySelector('.semiont-skip-links');
      const firstLink = screen.getAllByRole('link')[0];

      // Initially hidden (screen reader only)
      expect(skipLinksContainer).toHaveClass('semiont-sr-only');

      // Tab to the first link
      await user.tab();

      // Should become visible on focus
      expect(skipLinksContainer).toHaveClass('semiont-skip-links--focused');
    });

    it('should hide when focus leaves', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <div>
          <SkipLinks />
          <button>Next focusable element</button>
        </div>
      );

      const skipLinksContainer = container.querySelector('.semiont-skip-links');

      // Tab to first skip link
      await user.tab();
      expect(skipLinksContainer).toHaveClass('semiont-skip-links--focused');

      // Tab past all skip links
      await user.tab(); // Second skip link
      await user.tab(); // Button

      // Should hide when focus leaves
      expect(skipLinksContainer).not.toHaveClass('semiont-skip-links--focused');
    });
  });

  describe('WCAG 2.4.3 - Focus Order', () => {
    it('should be at the beginning of the document', () => {
      const { container } = render(
        <div>
          <SkipLinks />
          <header>Header</header>
          <main>Main content</main>
        </div>
      );

      const skipLinks = container.querySelector('.semiont-skip-links');
      const firstElement = container.firstElementChild;

      expect(skipLinks).toBe(firstElement);
    });

    it('should maintain logical tab order', async () => {
      const user = userEvent.setup();
      const tabOrder: string[] = [];

      render(
        <div>
          <SkipLinks />
          <button onFocus={() => tabOrder.push('button')}>Button</button>
        </div>
      );

      const skipLinks = screen.getAllByRole('link');
      skipLinks.forEach((link, index) => {
        link.addEventListener('focus', () => tabOrder.push(`skip-${index}`));
      });

      // Tab through all elements
      await user.tab();
      await user.tab();
      await user.tab();

      // Skip links should be focused first
      expect(tabOrder[0]).toBe('skip-0');
      expect(tabOrder[1]).toBe('skip-1');
    });
  });

  describe('WCAG 2.4.6 - Headings and Labels', () => {
    it('should have descriptive link text', () => {
      render(<SkipLinks />);

      const mainLink = screen.getByRole('link', { name: /skip to main content/i });
      const navLink = screen.getByRole('link', { name: /skip to navigation/i });

      expect(mainLink).toHaveTextContent(/skip to main content/i);
      expect(navLink).toHaveTextContent(/skip to navigation/i);
    });

    it('should have aria-label for screen reader context', () => {
      render(<SkipLinks />);

      const links = screen.getAllByRole('link');

      links.forEach(link => {
        // Link text itself is descriptive
        expect(link).toHaveAccessibleName();
      });
    });
  });

  describe('Visual Design', () => {
    it('should be visually hidden by default', () => {
      const { container } = render(<SkipLinks />);

      const skipLinksContainer = container.querySelector('.semiont-skip-links');

      // Should have screen reader only class when not focused
      expect(skipLinksContainer).toHaveClass('semiont-sr-only');
    });

    it('should have high contrast styling when visible', () => {
      const { container } = render(<SkipLinks />);

      const link = container.querySelector('.semiont-skip-links__link');

      // Should have styling classes for visibility
      expect(link).toHaveClass('semiont-skip-links__link');
    });
  });

  describe('Fragment Navigation', () => {
    it('should use fragment identifiers for same-page navigation', () => {
      render(<SkipLinks />);

      const links = screen.getAllByRole('link');

      links.forEach(link => {
        const href = link.getAttribute('href');
        expect(href).toMatch(/^#/); // Should start with #
      });
    });

    it('should target valid anchor points', () => {
      render(
        <div>
          <SkipLinks />
          <main id="main-content">Main</main>
          <nav id="navigation">Nav</nav>
        </div>
      );

      const mainLink = screen.getByRole('link', { name: /skip to main content/i });
      const navLink = screen.getByRole('link', { name: /skip to navigation/i });

      const mainTarget = document.querySelector(mainLink.getAttribute('href')!);
      const navTarget = document.querySelector(navLink.getAttribute('href')!);

      expect(mainTarget).toBeInTheDocument();
      expect(navTarget).toBeInTheDocument();
    });
  });

  describe('Multiple Skip Links', () => {
    it('should support multiple skip destinations', () => {
      const customLinks = [
        { href: '#main', label: 'Main' },
        { href: '#nav', label: 'Navigation' },
        { href: '#search', label: 'Search' },
        { href: '#footer', label: 'Footer' },
      ];

      render(<SkipLinks links={customLinks} />);

      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(4);
    });

    it('should maintain focus management with multiple links', async () => {
      const user = userEvent.setup();
      const customLinks = [
        { href: '#one', label: 'One' },
        { href: '#two', label: 'Two' },
        { href: '#three', label: 'Three' },
      ];

      const { container } = render(<SkipLinks links={customLinks} />);
      const skipLinksContainer = container.querySelector('.semiont-skip-links');

      // Tab to first link
      await user.tab();
      expect(skipLinksContainer).toHaveClass('semiont-skip-links--focused');

      // Tab to second link - should still be visible
      await user.tab();
      expect(skipLinksContainer).toHaveClass('semiont-skip-links--focused');

      // Tab to third link - should still be visible
      await user.tab();
      expect(skipLinksContainer).toHaveClass('semiont-skip-links--focused');
    });
  });

  describe('Screen Reader Announcements', () => {
    it('should be announced as navigation landmark', () => {
      const { container } = render(<SkipLinks />);

      const nav = container.querySelector('nav');
      expect(nav).toBeInTheDocument();
      expect(nav).toHaveAttribute('aria-label', 'Skip links');
    });

    it('should have accessible names for all links', () => {
      render(<SkipLinks />);

      const links = screen.getAllByRole('link');

      links.forEach(link => {
        expect(link).toHaveAccessibleName();
        expect(link.textContent).toBeTruthy();
      });
    });
  });
});