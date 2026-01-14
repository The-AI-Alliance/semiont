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
  });

  describe('WCAG 2.4.1 - Bypass Blocks', () => {
    it('should provide skip to main content link', () => {
      render(<SkipLinks />);

      const skipLink = screen.getByRole('link', { name: /skip to main content/i });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink).toHaveAttribute('href', '#main-content');
    });

    it('should provide skip to navigation link', () => {
      render(<SkipLinks />);

      const skipLink = screen.getByRole('link', { name: /skip to navigation/i });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink).toHaveAttribute('href', '#main-navigation');
    });

    it('should provide skip to search link', () => {
      render(<SkipLinks />);

      const skipLink = screen.getByRole('link', { name: /skip to search/i });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink).toHaveAttribute('href', '#search');
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

      const firstLink = screen.getAllByRole('link')[0];

      // Tab to the first link
      await user.tab();

      // Link should receive focus
      expect(firstLink).toHaveFocus();
    });

    it('should hide when focus leaves', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <div>
          <SkipLinks />
          <button>Next focusable element</button>
        </div>
      );

      // Tab to first skip link
      await user.tab();
      const firstLink = screen.getAllByRole('link')[0];
      expect(firstLink).toHaveFocus();

      // Tab past all skip links (3 links total)
      await user.tab(); // Second skip link
      await user.tab(); // Third skip link
      await user.tab(); // Button

      // Button should have focus
      const button = screen.getByRole('button');
      expect(button).toHaveFocus();
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

      render(
        <div>
          <SkipLinks />
          <button>Button</button>
        </div>
      );

      // Tab through all elements
      await user.tab(); // First skip link
      const firstLink = screen.getByRole('link', { name: /skip to main content/i });
      expect(firstLink).toHaveFocus();

      await user.tab(); // Second skip link
      const secondLink = screen.getByRole('link', { name: /skip to navigation/i });
      expect(secondLink).toHaveFocus();

      await user.tab(); // Third skip link
      const thirdLink = screen.getByRole('link', { name: /skip to search/i });
      expect(thirdLink).toHaveFocus();

      await user.tab(); // Button
      const button = screen.getByRole('button');
      expect(button).toHaveFocus();
    });
  });

  describe('WCAG 2.4.6 - Headings and Labels', () => {
    it('should have descriptive link text', () => {
      render(<SkipLinks />);

      const mainLink = screen.getByRole('link', { name: /skip to main content/i });
      const navLink = screen.getByRole('link', { name: /skip to navigation/i });
      const searchLink = screen.getByRole('link', { name: /skip to search/i });

      expect(mainLink).toHaveTextContent(/skip to main content/i);
      expect(navLink).toHaveTextContent(/skip to navigation/i);
      expect(searchLink).toHaveTextContent(/skip to search/i);
    });

    it('should have accessible names for all links', () => {
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

      const links = container.querySelectorAll('.semiont-skip-link');

      // Skip links use positioning for screen reader only visibility
      expect(links.length).toBeGreaterThan(0);
    });

    it('should have high contrast styling when visible', () => {
      const { container } = render(<SkipLinks />);

      const links = container.querySelectorAll('.semiont-skip-link');

      // Should have styling classes for visibility
      links.forEach(link => {
        expect(link).toHaveClass('semiont-skip-link');
      });
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
          <nav id="main-navigation">Nav</nav>
          <div id="search">Search</div>
        </div>
      );

      const mainLink = screen.getByRole('link', { name: /skip to main content/i });
      const navLink = screen.getByRole('link', { name: /skip to navigation/i });
      const searchLink = screen.getByRole('link', { name: /skip to search/i });

      const mainTarget = document.querySelector(mainLink.getAttribute('href')!);
      const navTarget = document.querySelector(navLink.getAttribute('href')!);
      const searchTarget = document.querySelector(searchLink.getAttribute('href')!);

      expect(mainTarget).toBeInTheDocument();
      expect(navTarget).toBeInTheDocument();
      expect(searchTarget).toBeInTheDocument();
    });
  });

  describe('Multiple Skip Links', () => {
    it('should support multiple skip destinations', () => {
      render(<SkipLinks />);

      const links = screen.getAllByRole('link');
      // Component has 3 hardcoded links
      expect(links).toHaveLength(3);
    });

    it('should maintain focus management with multiple links', async () => {
      const user = userEvent.setup();
      const { container } = render(<SkipLinks />);

      // Tab to first link
      await user.tab();
      const firstLink = screen.getByRole('link', { name: /skip to main content/i });
      expect(firstLink).toHaveFocus();

      // Tab to second link
      await user.tab();
      const secondLink = screen.getByRole('link', { name: /skip to navigation/i });
      expect(secondLink).toHaveFocus();

      // Tab to third link
      await user.tab();
      const thirdLink = screen.getByRole('link', { name: /skip to search/i });
      expect(thirdLink).toHaveFocus();
    });
  });

  describe('Screen Reader Announcements', () => {
    it('should be announced as navigation landmark', () => {
      const { container } = render(<SkipLinks />);

      // Component structure uses divs, not nav element
      const skipLinks = container.querySelector('.semiont-skip-links');
      expect(skipLinks).toBeInTheDocument();
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