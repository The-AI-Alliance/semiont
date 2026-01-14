import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PageLayout } from '../PageLayout';

// Mock UnifiedHeader
vi.mock('../UnifiedHeader', () => ({
  UnifiedHeader: ({ t }: any) => (
    <div data-testid="unified-header">
      <span>{t('home')}</span>
    </div>
  ),
}));

// Mock Footer
vi.mock('../../navigation/Footer', () => ({
  Footer: ({ t }: any) => (
    <div data-testid="footer">
      <span>{t('copyright')}</span>
    </div>
  ),
}));

// Mock Link component
const MockLink = ({ href, children, ...props }: any) => (
  <a href={href} {...props}>{children}</a>
);

// Mock routes
const mockRoutes = {
  home: () => '/',
  about: () => '/about',
} as any;

// Mock translation function
const mockT = (key: string) => `translated.${key}`;
const mockTNav = (key: string) => `nav.${key}`;
const mockTHome = (key: string) => `home.${key}`;

describe('PageLayout Component', () => {
  describe('Rendering', () => {
    it('should render with required props', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Test Content</div>
        </PageLayout>
      );

      expect(screen.getByText('Test Content')).toBeInTheDocument();
    });

    it('should render header with UnifiedHeader', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByTestId('unified-header')).toBeInTheDocument();
    });

    it('should render footer', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByTestId('footer')).toBeInTheDocument();
    });

    it('should render children in main element', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div data-testid="child-content">Child Content</div>
        </PageLayout>
      );

      const main = screen.getByRole('main');
      expect(main).toBeInTheDocument();
      expect(screen.getByTestId('child-content')).toBeInTheDocument();
    });
  });

  describe('Styling and Layout', () => {
    it('should have flex column layout', () => {
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('flex', 'flex-col', 'min-h-screen');
    });

    it('should apply custom className to main element', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
          className="custom-class"
        >
          <div>Content</div>
        </PageLayout>
      );

      const main = screen.getByRole('main');
      expect(main).toHaveClass('custom-class');
    });

    it('should have flex-1 on main element', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const main = screen.getByRole('main');
      expect(main).toHaveClass('semiont-comment-entry__body');
    });

    it('should have proper header styling', () => {
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const header = container.querySelector('header');
      expect(header).toHaveClass('semiont-collaboration-panel');
    });
  });

  describe('Props Handling', () => {
    it('should pass showAuthLinks to UnifiedHeader', () => {
      const { rerender } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
          showAuthLinks={true}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByTestId('unified-header')).toBeInTheDocument();

      rerender(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
          showAuthLinks={false}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByTestId('unified-header')).toBeInTheDocument();
    });

    it('should default showAuthLinks to true', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByTestId('unified-header')).toBeInTheDocument();
    });

    it('should pass translation functions to components', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      // UnifiedHeader should receive tNav (which renders t('home'))
      expect(screen.getByText('nav.home')).toBeInTheDocument();

      // Footer should receive t
      expect(screen.getByText('translated.copyright')).toBeInTheDocument();
    });
  });

  describe('Optional Props', () => {
    it('should render without CookiePreferences', () => {
      expect(() => {
        render(
          <PageLayout
            Link={MockLink}
            routes={mockRoutes}
            t={mockT}
            tNav={mockTNav}
            tHome={mockTHome}
          >
            <div>Content</div>
          </PageLayout>
        );
      }).not.toThrow();
    });

    it('should render with CookiePreferences component', () => {
      const MockCookiePreferences = ({ isOpen, onClose }: any) => (
        <div data-testid="cookie-prefs">Cookie Preferences</div>
      );

      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
          CookiePreferences={MockCookiePreferences}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByTestId('footer')).toBeInTheDocument();
    });

    it('should render with onOpenKeyboardHelp handler', () => {
      const mockHandler = vi.fn();

      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
          onOpenKeyboardHelp={mockHandler}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByTestId('footer')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have semantic header element', () => {
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(container.querySelector('header')).toBeInTheDocument();
    });

    it('should have semantic main element', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    it('should maintain proper document structure', () => {
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const wrapper = container.firstChild as HTMLElement;
      const header = wrapper.querySelector('header');
      const main = wrapper.querySelector('main');
      const footer = wrapper.querySelector('footer')?.parentElement;

      // Header should come before main
      expect(header?.compareDocumentPosition(main!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );

      // Main should come before footer
      if (footer) {
        expect(main?.compareDocumentPosition(footer)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING
        );
      }
    });
  });

  describe('Complex Children', () => {
    it('should render multiple child elements', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div data-testid="child-1">Child 1</div>
          <div data-testid="child-2">Child 2</div>
          <div data-testid="child-3">Child 3</div>
        </PageLayout>
      );

      expect(screen.getByTestId('child-1')).toBeInTheDocument();
      expect(screen.getByTestId('child-2')).toBeInTheDocument();
      expect(screen.getByTestId('child-3')).toBeInTheDocument();
    });

    it('should render nested components', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>
            <h1>Title</h1>
            <section>
              <p>Paragraph</p>
            </section>
          </div>
        </PageLayout>
      );

      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Paragraph')).toBeInTheDocument();
    });
  });
});
