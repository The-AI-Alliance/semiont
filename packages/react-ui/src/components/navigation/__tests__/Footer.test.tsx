import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Footer } from '../Footer';

// Mock Link component
const MockLink = ({ href, children, className }: any) => (
  <a href={href} className={className}>{children}</a>
);

// Mock routes
const mockRoutes = {
  about: () => '/about',
  privacy: () => '/privacy',
  terms: () => '/terms',
} as any;

// Mock translation function
const mockT = (key: string, params?: Record<string, any>) => {
  if (key === 'copyright' && params) {
    return `© ${params.year} Semiont`;
  }
  return `footer.${key}`;
};

describe('Footer Component', () => {
  describe('Rendering', () => {
    it('should render with required props', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      expect(screen.getByText(/© \d{4} Semiont/)).toBeInTheDocument();
    });

    it('should render copyright with current year', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const currentYear = new Date().getFullYear();
      expect(screen.getByText(`© ${currentYear} Semiont`)).toBeInTheDocument();
    });

    it('should render About link', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const aboutLink = screen.getByText('footer.about');
      expect(aboutLink).toBeInTheDocument();
      expect(aboutLink).toHaveAttribute('href', '/about');
    });

    it('should render Privacy Policy link', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const privacyLink = screen.getByText('footer.privacyPolicy');
      expect(privacyLink).toBeInTheDocument();
      expect(privacyLink).toHaveAttribute('href', '/privacy');
    });

    it('should render Terms of Service link', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const termsLink = screen.getByText('footer.termsOfService');
      expect(termsLink).toBeInTheDocument();
      expect(termsLink).toHaveAttribute('href', '/terms');
    });

    it('should render API Docs link with default URL', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const apiDocsLink = screen.getByText('footer.apiDocs');
      expect(apiDocsLink).toBeInTheDocument();
      expect(apiDocsLink).toHaveAttribute('href', '/api/docs');
      expect(apiDocsLink).toHaveAttribute('target', '_blank');
      expect(apiDocsLink).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('should render Source Code link with default URL', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const sourceLink = screen.getByText('footer.sourceCode');
      expect(sourceLink).toBeInTheDocument();
      expect(sourceLink).toHaveAttribute('href', 'https://github.com/The-AI-Alliance/semiont');
      expect(sourceLink).toHaveAttribute('target', '_blank');
      expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('Optional Features', () => {
    it('should not render Cookie Preferences button when not provided', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      expect(screen.queryByText('footer.cookiePreferences')).not.toBeInTheDocument();
    });

    it('should render Cookie Preferences button when provided', () => {
      const MockCookiePrefs = ({ isOpen, onClose }: any) => null;

      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          CookiePreferences={MockCookiePrefs}
        />
      );

      expect(screen.getByText('footer.cookiePreferences')).toBeInTheDocument();
    });

    it('should open Cookie Preferences modal when button clicked', () => {
      const MockCookiePrefs = ({ isOpen, onClose }: any) => (
        isOpen ? <div data-testid="cookie-modal">Cookie Preferences</div> : null
      );

      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          CookiePreferences={MockCookiePrefs}
        />
      );

      expect(screen.queryByTestId('cookie-modal')).not.toBeInTheDocument();

      const button = screen.getByText('footer.cookiePreferences');
      fireEvent.click(button);

      expect(screen.getByTestId('cookie-modal')).toBeInTheDocument();
    });

    it('should close Cookie Preferences modal when onClose called', () => {
      let closeHandler: (() => void) | null = null;
      const MockCookiePrefs = ({ isOpen, onClose }: any) => {
        closeHandler = onClose;
        return isOpen ? (
          <div data-testid="cookie-modal">
            <button onClick={onClose}>Close</button>
          </div>
        ) : null;
      };

      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          CookiePreferences={MockCookiePrefs}
        />
      );

      // Open modal
      const button = screen.getByText('footer.cookiePreferences');
      fireEvent.click(button);

      expect(screen.getByTestId('cookie-modal')).toBeInTheDocument();

      // Close modal
      const closeButton = screen.getByText('Close');
      fireEvent.click(closeButton);

      expect(screen.queryByTestId('cookie-modal')).not.toBeInTheDocument();
    });

    it('should not render Keyboard Shortcuts button when not provided', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      expect(screen.queryByText('footer.keyboardShortcuts')).not.toBeInTheDocument();
    });

    it('should render Keyboard Shortcuts button when provided', () => {
      const mockHandler = vi.fn();

      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          onOpenKeyboardHelp={mockHandler}
        />
      );

      expect(screen.getByText('footer.keyboardShortcuts')).toBeInTheDocument();
    });

    it('should call onOpenKeyboardHelp when button clicked', () => {
      const mockHandler = vi.fn();

      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          onOpenKeyboardHelp={mockHandler}
        />
      );

      const button = screen.getByText('footer.keyboardShortcuts');
      fireEvent.click(button);

      expect(mockHandler).toHaveBeenCalledOnce();
    });

    it('should show kbd hint with keyboard shortcut button', () => {
      const mockHandler = vi.fn();

      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          onOpenKeyboardHelp={mockHandler}
        />
      );

      const kbd = screen.getByText('?');
      expect(kbd.tagName).toBe('KBD');
    });
  });

  describe('Custom URLs', () => {
    it('should use custom API Docs URL', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          apiDocsUrl="/custom/api/docs"
        />
      );

      const apiDocsLink = screen.getByText('footer.apiDocs');
      expect(apiDocsLink).toHaveAttribute('href', '/custom/api/docs');
    });

    it('should use custom Source Code URL', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          sourceCodeUrl="https://custom-repo.com/project"
        />
      );

      const sourceLink = screen.getByText('footer.sourceCode');
      expect(sourceLink).toHaveAttribute('href', 'https://custom-repo.com/project');
    });
  });

  describe('Fallback Routes', () => {
    it('should use fallback About route when not provided', () => {
      const routesWithoutAbout = {} as any;

      render(
        <Footer
          Link={MockLink}
          routes={routesWithoutAbout}
          t={mockT}
        />
      );

      const aboutLink = screen.getByText('footer.about');
      expect(aboutLink).toHaveAttribute('href', '/about');
    });

    it('should use fallback Privacy route when not provided', () => {
      const routesWithoutPrivacy = {} as any;

      render(
        <Footer
          Link={MockLink}
          routes={routesWithoutPrivacy}
          t={mockT}
        />
      );

      const privacyLink = screen.getByText('footer.privacyPolicy');
      expect(privacyLink).toHaveAttribute('href', '/privacy');
    });

    it('should use fallback Terms route when not provided', () => {
      const routesWithoutTerms = {} as any;

      render(
        <Footer
          Link={MockLink}
          routes={routesWithoutTerms}
          t={mockT}
        />
      );

      const termsLink = screen.getByText('footer.termsOfService');
      expect(termsLink).toHaveAttribute('href', '/terms');
    });
  });

  describe('Styling and Layout', () => {
    it('should have proper footer styling', () => {
      const { container } = render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const footer = container.querySelector('footer');
      expect(footer).toHaveClass('semiont-footer');
    });

    it('should have responsive layout classes', () => {
      const { container } = render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const flexContainer = container.querySelector('.semiont-footer__container');
      expect(flexContainer).toBeInTheDocument();
    });

    it('should apply hover styles to links', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const aboutLink = screen.getByText('footer.about');
      expect(aboutLink).toHaveClass('semiont-footer__link');
    });
  });

  describe('Accessibility', () => {
    it('should use semantic footer element', () => {
      const { container } = render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      expect(container.querySelector('footer')).toBeInTheDocument();
    });

    it('should have proper external link attributes', () => {
      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
        />
      );

      const apiDocsLink = screen.getByText('footer.apiDocs');
      expect(apiDocsLink).toHaveAttribute('rel', 'noopener noreferrer');

      const sourceLink = screen.getByText('footer.sourceCode');
      expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('should have proper button elements for interactive features', () => {
      const mockHandler = vi.fn();
      const MockCookiePrefs = ({ isOpen, onClose }: any) => null;

      render(
        <Footer
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          CookiePreferences={MockCookiePrefs}
          onOpenKeyboardHelp={mockHandler}
        />
      );

      const cookieButton = screen.getByText('footer.cookiePreferences');
      expect(cookieButton.tagName).toBe('BUTTON');

      const keyboardButton = screen.getByText('footer.keyboardShortcuts');
      expect(keyboardButton.tagName).toBe('BUTTON');
    });
  });
});
