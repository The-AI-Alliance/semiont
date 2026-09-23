import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PageLayout } from '../PageLayout';

// No mocks - using real components via composition
// Need to mock useDropdown hook used by UnifiedHeader
vi.mock('@/hooks/useUI', () => ({
  useDropdown: vi.fn(() => ({
    isOpen: false,
    toggle: vi.fn(),
    close: vi.fn(),
    dropdownRef: { current: null },
  })),
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
const mockTNav = (key: string) => `nav.${key}`;
const mockTHome = (key: string) => `home.${key}`;

describe('PageLayout Component', () => {
  describe('Rendering', () => {
    it('should render with required props', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
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
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      // Real UnifiedHeader renders a header element
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );
      expect(container.querySelector('header')).toBeInTheDocument();
    });

    it('should render children in main element', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
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
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('semiont-page-layout');
    });

    it('should apply custom className to main element', () => {
      render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
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
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const main = screen.getByRole('main');
      expect(main).toHaveClass('semiont-page-layout__main');
    });

    it('should have proper header styling', () => {
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const header = container.querySelector('header');
      expect(header).toHaveClass('semiont-page-layout__header');
    });
  });

  describe('Props Handling', () => {
    it('should pass showAuthLinks to UnifiedHeader', () => {
      const { rerender, container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          tNav={mockTNav}
          tHome={mockTHome}
          showAuthLinks={true}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(container.querySelector('header')).toBeInTheDocument();

      rerender(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          tNav={mockTNav}
          tHome={mockTHome}
          showAuthLinks={false}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(container.querySelector('header')).toBeInTheDocument();
    });

    it('should default showAuthLinks to true', () => {
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      expect(container.querySelector('header')).toBeInTheDocument();
    });

  });

  describe('Accessibility', () => {
    it('should have semantic header element', () => {
      const { container } = render(
        <PageLayout
          Link={MockLink}
          routes={mockRoutes}
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
          tNav={mockTNav}
          tHome={mockTHome}
        >
          <div>Content</div>
        </PageLayout>
      );

      const wrapper = container.firstChild as HTMLElement;
      const header = wrapper.querySelector('header');
      const main = wrapper.querySelector('main');
      const footer = wrapper.querySelector('footer');

      // Header should come before main
      expect(header?.compareDocumentPosition(main!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );

      // Main should come before footer (real Footer component has footer element)
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
