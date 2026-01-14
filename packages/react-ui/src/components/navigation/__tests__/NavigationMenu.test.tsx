import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NavigationMenu } from '../NavigationMenu';
import type { LinkComponentProps } from '../../../contexts/RoutingContext';

describe('NavigationMenu Component', () => {
  const mockLink = vi.fn(({ href, children, className, onClick, ...props }: LinkComponentProps) => (
    <a href={href} className={className} onClick={onClick} {...props}>
      {children}
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

  const mockOnItemClick = vi.fn();

  beforeEach(() => {
    mockLink.mockClear();
    mockRoutes.knowledge.mockClear();
    mockRoutes.moderate.mockClear();
    mockRoutes.admin.mockClear();
    mockTranslate.mockClear();
    mockOnItemClick.mockClear();
  });

  describe('Basic Rendering', () => {
    it('should render home link', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(mockTranslate).toHaveBeenCalledWith('home');
    });

    it('should render knowledge link', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(screen.getByText('Knowledge')).toBeInTheDocument();
      expect(mockTranslate).toHaveBeenCalledWith('know');
    });

    it('should render all navigation links', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const links = container.querySelectorAll('a');
      expect(links.length).toBeGreaterThanOrEqual(2);
    });

    it('should render dividers between sections', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const dividers = container.querySelectorAll('hr');
      expect(dividers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Link URLs', () => {
    it('should use brandingLink for home', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          brandingLink="/custom-home"
        />
      );

      const homeLink = screen.getByText('Home').closest('a');
      expect(homeLink).toHaveAttribute('href', '/custom-home');
    });

    it('should use default home link when brandingLink not provided', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const homeLink = screen.getByText('Home').closest('a');
      expect(homeLink).toHaveAttribute('href', '/');
    });

    it('should use routes.knowledge for knowledge link', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(mockRoutes.knowledge).toHaveBeenCalled();
      const knowledgeLink = screen.getByText('Knowledge').closest('a');
      expect(knowledgeLink).toHaveAttribute('href', '/knowledge');
    });

    it('should fallback to /know if routes.knowledge is undefined', () => {
      const routesWithoutKnowledge = { ...mockRoutes, knowledge: undefined };

      render(
        <NavigationMenu
          Link={mockLink}
          routes={routesWithoutKnowledge}
          t={mockTranslate}
        />
      );

      const knowledgeLink = screen.getByText('Knowledge').closest('a');
      expect(knowledgeLink).toHaveAttribute('href', '/know');
    });

    it('should use routes.moderate for moderate link', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isModerator={true}
        />
      );

      expect(mockRoutes.moderate).toHaveBeenCalled();
      const moderateLink = screen.getByText('Moderate').closest('a');
      expect(moderateLink).toHaveAttribute('href', '/moderate');
    });

    it('should fallback to /moderate if routes.moderate is undefined', () => {
      const routesWithoutModerate = { ...mockRoutes, moderate: undefined };

      render(
        <NavigationMenu
          Link={mockLink}
          routes={routesWithoutModerate}
          t={mockTranslate}
          isModerator={true}
        />
      );

      const moderateLink = screen.getByText('Moderate').closest('a');
      expect(moderateLink).toHaveAttribute('href', '/moderate');
    });

    it('should use routes.admin for admin link', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      expect(mockRoutes.admin).toHaveBeenCalled();
      const adminLink = screen.getByText('Administer').closest('a');
      expect(adminLink).toHaveAttribute('href', '/admin');
    });

    it('should fallback to /admin if routes.admin is undefined', () => {
      const routesWithoutAdmin = { ...mockRoutes, admin: undefined };

      render(
        <NavigationMenu
          Link={mockLink}
          routes={routesWithoutAdmin}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      const adminLink = screen.getByText('Administer').closest('a');
      expect(adminLink).toHaveAttribute('href', '/admin');
    });
  });

  describe('Moderator Access', () => {
    it('should show moderate link when isModerator is true', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isModerator={true}
        />
      );

      expect(screen.getByText('Moderate')).toBeInTheDocument();
    });

    it('should hide moderate link when isModerator is false', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isModerator={false}
        />
      );

      expect(screen.queryByText('Moderate')).not.toBeInTheDocument();
    });

    it('should hide moderate link by default', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(screen.queryByText('Moderate')).not.toBeInTheDocument();
    });

    it('should show moderate link when isAdmin is true', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      expect(screen.getByText('Moderate')).toBeInTheDocument();
    });

    it('should show divider after moderate link', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isModerator={true}
        />
      );

      const moderateLink = screen.getByText('Moderate');
      const nextSibling = moderateLink.closest('a')?.nextElementSibling;
      expect(nextSibling?.tagName).toBe('HR');
    });
  });

  describe('Admin Access', () => {
    it('should show admin link when isAdmin is true', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      expect(screen.getByText('Administer')).toBeInTheDocument();
    });

    it('should hide admin link when isAdmin is false', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={false}
        />
      );

      expect(screen.queryByText('Administer')).not.toBeInTheDocument();
    });

    it('should hide admin link by default', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(screen.queryByText('Administer')).not.toBeInTheDocument();
    });

    it('should not show extra divider after admin link', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      const adminLink = screen.getByText('Administer').closest('a');
      const nextSibling = adminLink?.nextElementSibling;
      expect(nextSibling?.tagName).not.toBe('HR');
    });
  });

  describe('Combined Permissions', () => {
    it('should show both moderate and admin links for admin user', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      expect(screen.getByText('Moderate')).toBeInTheDocument();
      expect(screen.getByText('Administer')).toBeInTheDocument();
    });

    it('should show only moderate link for moderator user', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isModerator={true}
          isAdmin={false}
        />
      );

      expect(screen.getByText('Moderate')).toBeInTheDocument();
      expect(screen.queryByText('Administer')).not.toBeInTheDocument();
    });

    it('should show all links for admin and moderator user', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          isModerator={true}
        />
      );

      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(screen.getByText('Knowledge')).toBeInTheDocument();
      expect(screen.getByText('Moderate')).toBeInTheDocument();
      expect(screen.getByText('Administer')).toBeInTheDocument();
    });
  });

  describe('Click Handling', () => {
    it('should call onItemClick when home link is clicked', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          onItemClick={mockOnItemClick}
        />
      );

      const homeLink = screen.getByText('Home');
      fireEvent.click(homeLink);

      expect(mockOnItemClick).toHaveBeenCalledTimes(1);
    });

    it('should call onItemClick when knowledge link is clicked', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          onItemClick={mockOnItemClick}
        />
      );

      const knowledgeLink = screen.getByText('Knowledge');
      fireEvent.click(knowledgeLink);

      expect(mockOnItemClick).toHaveBeenCalledTimes(1);
    });

    it('should call onItemClick when moderate link is clicked', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isModerator={true}
          onItemClick={mockOnItemClick}
        />
      );

      const moderateLink = screen.getByText('Moderate');
      fireEvent.click(moderateLink);

      expect(mockOnItemClick).toHaveBeenCalledTimes(1);
    });

    it('should call onItemClick when admin link is clicked', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
          onItemClick={mockOnItemClick}
        />
      );

      const adminLink = screen.getByText('Administer');
      fireEvent.click(adminLink);

      expect(mockOnItemClick).toHaveBeenCalledTimes(1);
    });

    it('should not pass onClick when onItemClick is not provided', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const homeLink = screen.getByText('Home').closest('a');
      expect(homeLink).not.toHaveAttribute('onClick');
    });
  });

  describe('Styling', () => {
    it('should apply base className to container', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(container.firstChild).toHaveClass('semiont-navigation-menu');
    });

    it('should apply custom className with base className to container', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          className="custom-nav"
        />
      );

      expect(container.firstChild).toHaveClass('semiont-navigation-menu');
      expect(container.firstChild).toHaveClass('custom-nav');
    });

    it('should apply semantic link styles to all links', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      const links = container.querySelectorAll('a');
      links.forEach(link => {
        expect(link).toHaveClass('semiont-navigation-menu__link');
      });
    });

    it('should apply semantic divider styles', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const dividers = container.querySelectorAll('hr');
      dividers.forEach(divider => {
        expect(divider).toHaveClass('semiont-navigation-menu__divider');
      });
    });
  });

  describe('Accessibility', () => {
    it('should have navigation landmark with aria-label', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const nav = container.querySelector('nav');
      expect(nav).toHaveAttribute('aria-label', 'Main navigation');
    });

    it('should mark current page with aria-current', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          currentPath="/knowledge"
        />
      );

      const knowledgeLink = screen.getByText('Knowledge').closest('a');
      expect(knowledgeLink).toHaveAttribute('aria-current', 'page');
    });

    it('should not have aria-current on non-current pages', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          currentPath="/knowledge"
        />
      );

      const homeLink = screen.getByText('Home').closest('a');
      expect(homeLink).not.toHaveAttribute('aria-current');
    });

    it('should have accessible link text', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(screen.getByText('Knowledge')).toBeInTheDocument();
    });

    it('should have semantic navigation structure', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      const nav = container.querySelector('nav');
      expect(nav).toBeInTheDocument();
      const links = nav?.querySelectorAll('a');
      expect(links).toHaveLength(4); // Home, Knowledge, Moderate, Admin
    });
  });

  describe('Translation Integration', () => {
    it('should translate all menu items', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      expect(mockTranslate).toHaveBeenCalledWith('home');
      expect(mockTranslate).toHaveBeenCalledWith('know');
      expect(mockTranslate).toHaveBeenCalledWith('moderate');
      expect(mockTranslate).toHaveBeenCalledWith('administer');
    });

    it('should use custom translations', () => {
      const customTranslate = vi.fn((key: string) => {
        const translations: Record<string, string> = {
          'home': 'Casa',
          'know': 'Conocimiento',
          'moderate': 'Moderar',
          'administer': 'Administrar',
        };
        return translations[key] || key;
      });

      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={customTranslate}
          isAdmin={true}
        />
      );

      expect(screen.getByText('Casa')).toBeInTheDocument();
      expect(screen.getByText('Conocimiento')).toBeInTheDocument();
      expect(screen.getByText('Moderar')).toBeInTheDocument();
      expect(screen.getByText('Administrar')).toBeInTheDocument();
    });

    it('should only translate visible items', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
          isAdmin={false}
          isModerator={false}
        />
      );

      expect(mockTranslate).toHaveBeenCalledWith('home');
      expect(mockTranslate).toHaveBeenCalledWith('know');
      expect(mockTranslate).not.toHaveBeenCalledWith('moderate');
      expect(mockTranslate).not.toHaveBeenCalledWith('administer');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty routes object', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={{}}
          t={mockTranslate}
        />
      );

      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(screen.getByText('Knowledge')).toBeInTheDocument();
    });

    it('should handle routes that return null', () => {
      const nullRoutes = {
        knowledge: () => null as any,
        moderate: () => null as any,
        admin: () => null as any,
      };

      render(
        <NavigationMenu
          Link={mockLink}
          routes={nullRoutes}
          t={mockTranslate}
          isAdmin={true}
        />
      );

      // Should fallback to default routes
      const knowledgeLink = screen.getByText('Knowledge').closest('a');
      expect(knowledgeLink).toHaveAttribute('href', '/know');
    });

    it('should handle all combinations of permissions', () => {
      const permutations = [
        { isAdmin: false, isModerator: false, expectedCount: 2 },
        { isAdmin: false, isModerator: true, expectedCount: 3 },
        { isAdmin: true, isModerator: false, expectedCount: 4 },
        { isAdmin: true, isModerator: true, expectedCount: 4 },
      ];

      permutations.forEach(({ isAdmin, isModerator, expectedCount }) => {
        const { container } = render(
          <NavigationMenu
            Link={mockLink}
            routes={mockRoutes}
            t={mockTranslate}
            isAdmin={isAdmin}
            isModerator={isModerator}
          />
        );

        const links = container.querySelectorAll('a');
        expect(links).toHaveLength(expectedCount);
      });
    });
  });
});
