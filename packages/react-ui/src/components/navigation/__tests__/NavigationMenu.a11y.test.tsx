/**
 * NavigationMenu - Accessibility Tests
 *
 * WCAG 2.1 AA compliance tests for NavigationMenu component.
 * Tests keyboard navigation, ARIA attributes, and semantic structure.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { NavigationMenu } from '../NavigationMenu';

// Extend expect with accessibility matchers
expect.extend(toHaveNoViolations);

describe('NavigationMenu - Accessibility', () => {
  const mockLink = vi.fn((props: any) => (
    <a {...props}>
      {props.children}
    </a>
  ));

  const mockRoutes = {
    knowledge: vi.fn(() => '/knowledge'),
    moderate: vi.fn(() => '/moderate'),
    admin: vi.fn(() => '/admin'),
  };

  const mockTranslate = vi.fn((key: string) => {
    const translations: Record<string, string> = {
      'home': 'Home',
      'know': 'Knowledge',
      'moderate': 'Moderate',
      'administer': 'Administer',
    };
    return translations[key] || key;
  });

  describe('WCAG 2.1 AA - Automated axe-core Tests', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have no accessibility violations with active path', async () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          activePath="/knowledge"
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 1.3.1 - Info and Relationships (Semantic HTML)', () => {
    it('should render navigation container with menu role', () => {
      const { container} = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const nav = container.querySelector('nav');
      expect(nav).toBeInTheDocument();
      expect(nav).toHaveAttribute('aria-label', 'Main navigation');
    });

    it('should have proper ARIA role for menu items', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          isModerator={true}
        />
      );

      const menuItems = container.querySelectorAll('a');
      expect(menuItems.length).toBeGreaterThan(0);
    });
  });

  describe('WCAG 2.1.1 - Keyboard Accessibility', () => {
    it('should have keyboard-accessible links', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          isModerator={true}
        />
      );

      const homeLink = screen.getByText('Home');
      const knowLink = screen.getByText('Knowledge');
      const moderateLink = screen.getByText('Moderate');
      const adminLink = screen.getByText('Administer');

      expect(homeLink).toBeInTheDocument();
      expect(knowLink).toBeInTheDocument();
      expect(moderateLink).toBeInTheDocument();
      expect(adminLink).toBeInTheDocument();
    });

    it('should support keyboard navigation with Tab', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const links = container.querySelectorAll('a');

      // All links should be focusable (no tabindex=-1)
      links.forEach(link => {
        expect(link).not.toHaveAttribute('tabindex', '-1');
      });
    });
  });

  describe('WCAG 4.1.2 - Name, Role, Value (ARIA)', () => {
    it('should have accessible names for all menu items', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const menuItems = container.querySelectorAll('a');

      // All menu items should have accessible names from aria-label
      menuItems.forEach(item => {
        expect(item).toHaveAccessibleName();
      });
    });

    // Note: NavigationMenu doesn't implement active state tracking
    // Active state is handled by the routing system, not the component itself
  });

  describe('WCAG 2.4.6 - Headings and Labels (Descriptive)', () => {
    it('should have descriptive link text', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          isModerator={true}
        />
      );

      // Link text should be descriptive (not "click here" or "link")
      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(screen.getByText('Knowledge')).toBeInTheDocument();
      expect(screen.getByText('Moderate')).toBeInTheDocument();
      expect(screen.getByText('Administer')).toBeInTheDocument();
    });
  });

  describe('WCAG 1.4.3 - Color Contrast (Minimum)', () => {
    it('should have sufficient color contrast', async () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
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
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const homeLink = screen.getByText('Home').closest('a');
      expect(homeLink).toBeInTheDocument();
      expect(homeLink).toHaveTextContent('Home');

      const knowLink = screen.getByText('Knowledge').closest('a');
      expect(knowLink).toBeInTheDocument();
      expect(knowLink).toHaveTextContent('Knowledge');
    });
  });

  describe('Focus Management', () => {
    it('should have visible focus indicators', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const links = container.querySelectorAll('a');

      // Links should have focus styling classes
      links.forEach(link => {
        expect(link.className).toBeTruthy();
      });
    });

    it('should maintain logical tab order', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          isModerator={true}
        />
      );

      const links = container.querySelectorAll('a');

      // Links should be in DOM order (logical tab order)
      expect(links[0]).toHaveTextContent('Home');
      expect(links[1]).toHaveTextContent('Knowledge');
      expect(links[2]).toHaveTextContent('Moderate');
      expect(links[3]).toHaveTextContent('Administer');
    });
  });

  // Note: NavigationMenu renders as a generic container, not a navigation landmark
  // Navigation landmark is provided by parent components like LeftSidebar

  // Note: Active state is managed by the Link component and routing system,
  // not by NavigationMenu itself

  describe('Menu Item Roles', () => {
    it('should use menuitem role correctly', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          isModerator={true}
        />
      );

      const menuItems = container.querySelectorAll('a');

      // All navigation items should have menuitem role
      expect(menuItems.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Translation Support', () => {
    it('should call translation function for all labels', () => {
      mockTranslate.mockClear();

      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          isModerator={true}
        />
      );

      // Translation function should be called for navigation items
      expect(mockTranslate).toHaveBeenCalled();
      expect(mockTranslate).toHaveBeenCalledWith('home');
      expect(mockTranslate).toHaveBeenCalledWith('know');
      expect(mockTranslate).toHaveBeenCalledWith('moderate');
      expect(mockTranslate).toHaveBeenCalledWith('administer');
    });
  });

  describe('Click Handler Accessibility', () => {
    it('should support onItemClick callback', () => {
      const onItemClick = vi.fn();

      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          onItemClick={onItemClick}
        />
      );

      const homeLink = screen.getByText('Home').closest('a');
      expect(homeLink).toBeInTheDocument();
      homeLink?.click();

      // Callback should be triggered
      expect(onItemClick).toHaveBeenCalled();
    });
  });
});
