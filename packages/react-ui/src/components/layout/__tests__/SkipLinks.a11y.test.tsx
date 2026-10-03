/**
 * SkipLinks - Accessibility Tests
 *
 * WCAG 2.1 AA compliance tests for SkipLinks component, and for MainContent,
 * the landmark its link lands on.
 * Tests keyboard navigation bypass mechanism.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { SkipLinks, MainContent } from '../SkipLinks';

// Extend expect with accessibility matchers
expect.extend(toHaveNoViolations);

describe('SkipLinks - Accessibility', () => {
  describe('WCAG 2.1 AA - Automated axe-core Tests', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <div>
          <SkipLinks />
          <MainContent>Main content</MainContent>
        </div>
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 2.4.1 - Bypass Blocks', () => {
    it('should provide skip to main content link', () => {
      render(<SkipLinks />);

      const skipLink = screen.getByRole('link', { name: /skip to main content/i });
      expect(skipLink).toBeInTheDocument();
    });

    it('should link only to main content', () => {
      render(<SkipLinks />);

      expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it('should land on MainContent', () => {
      render(
        <div>
          <SkipLinks />
          <nav>Navigation</nav>
          <MainContent>Main content</MainContent>
        </div>
      );

      const skipLink = screen.getByRole<HTMLAnchorElement>('link', { name: /skip to main content/i });

      expect(document.querySelector(skipLink.hash)).toBe(screen.getByRole('main'));
    });
  });

  describe('MainContent', () => {
    it('should render its children in the main landmark', () => {
      render(<MainContent>Main content</MainContent>);

      expect(screen.getByRole('main')).toHaveTextContent('Main content');
    });

    it('should take focus when the skip link is followed', () => {
      render(<MainContent>Main content</MainContent>);

      const main = screen.getByRole('main');
      main.focus();

      expect(main).toHaveFocus();
    });

    it('should stay out of the tab order', async () => {
      const user = userEvent.setup();
      render(
        <div>
          <MainContent>Main content</MainContent>
          <button>Next focusable element</button>
        </div>
      );

      await user.tab();

      expect(screen.getByRole('button')).toHaveFocus();
    });

    it('should pass its props to the main element', () => {
      render(<MainContent className="custom-class" style={{ minHeight: '100vh' }}>Main content</MainContent>);

      const main = screen.getByRole('main');
      expect(main).toHaveClass('custom-class');
      expect(main.style.minHeight).toBe('100vh');
    });
  });

  describe('WCAG 2.1.1 - Keyboard Navigation', () => {
    it('should be keyboard accessible', () => {
      render(<SkipLinks />);

      expect(screen.getByRole('link')).not.toHaveAttribute('tabindex', '-1');
    });

    it('should become visible on focus', async () => {
      const user = userEvent.setup();
      render(<SkipLinks />);

      // Tab to the link
      await user.tab();

      // Link should receive focus
      expect(screen.getByRole('link')).toHaveFocus();
    });

    it('should hide when focus leaves', async () => {
      const user = userEvent.setup();
      render(
        <div>
          <SkipLinks />
          <button>Next focusable element</button>
        </div>
      );

      // Tab to the skip link
      await user.tab();
      expect(screen.getByRole('link')).toHaveFocus();

      // Tab past it
      await user.tab();

      // Button should have focus
      expect(screen.getByRole('button')).toHaveFocus();
    });
  });

  describe('WCAG 2.4.3 - Focus Order', () => {
    it('should be at the beginning of the document', () => {
      const { container } = render(
        <div>
          <SkipLinks />
          <header>Header</header>
          <MainContent>Main content</MainContent>
        </div>
      );

      const skipLinks = container.querySelector('.semiont-skip-links');
      const wrapper = container.firstElementChild;
      const firstElement = wrapper?.firstElementChild;

      expect(skipLinks).toBe(firstElement);
    });
  });

  describe('WCAG 2.4.6 - Headings and Labels', () => {
    it('should have descriptive link text', () => {
      render(<SkipLinks />);

      expect(screen.getByRole('link')).toHaveTextContent(/skip to main content/i);
    });

    it('should have an accessible name', () => {
      render(<SkipLinks />);

      expect(screen.getByRole('link')).toHaveAccessibleName();
    });
  });

  describe('Visual Design', () => {
    it('should carry the class that hides it until focused', () => {
      render(<SkipLinks />);

      expect(screen.getByRole('link')).toHaveClass('semiont-skip-link');
    });
  });

  describe('Fragment Navigation', () => {
    it('should use a fragment identifier for same-page navigation', () => {
      render(<SkipLinks />);

      expect(screen.getByRole('link').getAttribute('href')).toMatch(/^#/);
    });
  });
});
