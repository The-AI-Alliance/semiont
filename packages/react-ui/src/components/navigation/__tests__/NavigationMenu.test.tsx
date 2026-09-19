import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NavigationMenu } from '../NavigationMenu';
import type { LinkComponentProps } from '../../../contexts/RoutingContext';

describe('NavigationMenu Component', () => {
  const mockLink = vi.fn(({ href, children, className, onClick, ...props }: LinkComponentProps) => (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        if (onClick) onClick(e);
      }}
      {...props}
    >
      {children}
    </a>
  ));

  const mockRoutes = {
    knowledge: vi.fn(() => '/knowledge'),
    moderate: vi.fn(() => '/moderate'),
  };

  const mockTranslate = vi.fn((key: string) => {
    const translations: Record<string, string> = {
      'know': 'Knowledge',
      'moderate': 'Moderate',
    };
    return translations[key] || key;
  });

  const mockOnItemClick = vi.fn();

  beforeEach(() => {
    mockLink.mockClear();
    mockRoutes.knowledge.mockClear();
    mockRoutes.moderate.mockClear();
    mockTranslate.mockClear();
    mockOnItemClick.mockClear();
  });

  describe('Basic Rendering', () => {
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

    it('should render both links, with a divider between them', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      // Knowledge and Moderate. The menu takes no permission input any more,
      // so there is no "no permissions" case to render differently.
      expect(container.querySelectorAll('a').length).toBe(2);
      expect(container.querySelectorAll('hr').length).toBe(1);
    });
  });

  describe('Link URLs', () => {
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
        />
      );

      const moderateLink = screen.getByText('Moderate').closest('a');
      expect(moderateLink).toHaveAttribute('href', '/moderate');
    });

  });

  describe('Moderation Link', () => {
    /**
     * The moderation surface is shown to every authenticated user. The link
     * used to be gated on an `isModerator` prop, which gated nothing real —
     * the gateway grants no access on that basis and never did, so hiding the
     * link only obscured a page anyone could reach by typing its path.
     */
    it('should always render the moderate link', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(screen.getByText('Moderate')).toBeInTheDocument();
    });
  });

  describe('Click Handling', () => {
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
          onItemClick={mockOnItemClick}
        />
      );

      const moderateLink = screen.getByText('Moderate');
      fireEvent.click(moderateLink);

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

      const knowledgeLink = screen.getByText('Knowledge').closest('a');
      expect(knowledgeLink).not.toHaveAttribute('onClick');
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

      const moderateLink = screen.getByText('Moderate').closest('a');
      expect(moderateLink).not.toHaveAttribute('aria-current');
    });

    it('should have accessible link text', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(screen.getByText('Knowledge')).toBeInTheDocument();
    });

    it('should have semantic navigation structure', () => {
      const { container } = render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      const nav = container.querySelector('nav');
      expect(nav).toBeInTheDocument();
      const links = nav?.querySelectorAll('a');
      expect(links).toHaveLength(2); // Knowledge, Moderate
    });
  });

  describe('Translation Integration', () => {
    it('should translate all menu items', () => {
      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={mockTranslate}
        />
      );

      expect(mockTranslate).toHaveBeenCalledWith('know');
      expect(mockTranslate).toHaveBeenCalledWith('moderate');
    });

    it('should use custom translations', () => {
      const customTranslate = vi.fn((key: string) => {
        const translations: Record<string, string> = {
          'know': 'Conocimiento',
          'moderate': 'Moderar',
        };
        return translations[key] || key;
      });

      render(
        <NavigationMenu
          Link={mockLink}
          routes={mockRoutes}
          t={customTranslate}
        />
      );

      expect(screen.getByText('Conocimiento')).toBeInTheDocument();
      expect(screen.getByText('Moderar')).toBeInTheDocument();
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

      expect(screen.getByText('Knowledge')).toBeInTheDocument();
    });

    it('should handle routes that return null', () => {
      const nullRoutes = {
        knowledge: () => null as any,
        moderate: () => null as any,
      };

      render(
        <NavigationMenu
          Link={mockLink}
          routes={nullRoutes}
          t={mockTranslate}
        />
      );

      // Should fallback to default routes
      const knowledgeLink = screen.getByText('Knowledge').closest('a');
      expect(knowledgeLink).toHaveAttribute('href', '/know');
    });

  });
});
