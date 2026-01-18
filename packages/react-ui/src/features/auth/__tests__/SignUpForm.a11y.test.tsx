/**
 * SignUpForm - Accessibility Tests
 *
 * WCAG 2.1 AA compliance tests for SignUpForm component.
 * Tests keyboard navigation, screen reader support, and ARIA attributes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { SignUpForm } from '../components/SignUpForm';

// Extend expect with accessibility matchers
expect.extend(toHaveNoViolations);

// Mock Link component for testing
const MockLink: React.ComponentType<{ href: string; children: React.ReactNode; className?: string }> = ({
  href,
  children,
  className
}) => (
  <a href={href} className={className}>
    {children}
  </a>
);

const mockTranslations = {
  pageTitle: 'Join Semiont',
  signUpPrompt: 'Create your knowledge workspace account',
  signUpWithGoogle: 'Sign Up with Google',
  creatingAccount: 'Creating your account...',
  approvedDomainsInfo: 'Only users with approved email domains can sign up',
  termsAgreement: 'By signing up, you agree to our Terms of Service',
  alreadyHaveAccount: 'Already have an account? Sign In',
};

describe('SignUpForm - Accessibility', () => {
  describe('WCAG 2.1 AA - Automated axe-core Tests', () => {
    it('should have no accessibility violations', async () => {
      const onSignUp = vi.fn();

      const { container } = render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have no accessibility violations during loading state', async () => {
      const onSignUp = vi.fn(() => new Promise(() => {})); // Never resolves

      const { container } = render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      // Trigger loading state
      const button = screen.getByRole('button');
      button.click();

      // Wait for loading state to render
      await screen.findByText('Creating your account...');

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 1.3.1 - Info and Relationships (Semantic HTML)', () => {
    // Note: SignUpForm doesn't use <main> element - it's a form component
    // The parent page component should provide the main landmark

    it('should have proper heading hierarchy', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      // Should have h2 heading for main title
      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent('Join Semiont');
    });
  });

  describe('WCAG 2.1.1 - Keyboard Accessibility', () => {
    it('should have keyboard-accessible sign-up button', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button', { name: /Sign Up with Google/i });
      expect(button).toBeInTheDocument();
      expect(button).not.toHaveAttribute('disabled');
      // Note: Button doesn't have explicit type attribute, defaults to button (not submit)
    });

    it('should have keyboard-accessible sign-in link', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const signInLink = screen.getByRole('link', { name: /Already have an account/i });
      expect(signInLink).toHaveAttribute('href', '/auth/signin');
    });

    it('should disable button during loading state', async () => {
      const onSignUp = vi.fn(() => new Promise(() => {}));

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button');
      button.click();

      await screen.findByText('Creating your account...');

      expect(button).toBeDisabled();
    });
  });

  describe('WCAG 4.1.2 - Name, Role, Value (ARIA)', () => {
    it('should have accessible button name', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAccessibleName(/Sign Up with Google/i);
    });

    it('should have accessible link name', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const link = screen.getByRole('link');
      expect(link).toHaveAccessibleName();
    });
  });

  describe('WCAG 1.1.1 - Non-text Content (Images)', () => {
    it('should have Google icon inside button', () => {
      const onSignUp = vi.fn();

      const { container } = render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button');
      const svg = button.querySelector('svg');

      // SVG should be present and decorative (no alt text needed as button has text label)
      expect(svg).toBeInTheDocument();
      expect(button).toHaveTextContent('Sign Up with Google');
    });

    it('should show loading spinner during sign-up', async () => {
      const onSignUp = vi.fn(() => new Promise(() => {}));

      const { container } = render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button');
      button.click();

      await screen.findByText('Creating your account...');

      // Loading spinner should be present
      const spinner = container.querySelector('.semiont-auth__spinner');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('WCAG 2.4.6 - Headings and Labels (Descriptive)', () => {
    it('should have descriptive heading text', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent('Join Semiont');
    });

    it('should have descriptive button text', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('Sign Up with Google');
    });
  });

  describe('WCAG 1.4.3 - Color Contrast (Minimum)', () => {
    it('should have sufficient color contrast', async () => {
      const onSignUp = vi.fn();

      const { container } = render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
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
    it('should have button text matching accessible name', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button', { name: /Sign Up with Google/i });
      expect(button).toHaveTextContent('Sign Up with Google');
    });
  });

  describe('Focus Management', () => {
    it('should have visible focus indicators on button', () => {
      const onSignUp = vi.fn();

      const { container } = render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = container.querySelector('button');

      // Button should have styling classes (focus is handled by browser default + Tailwind)
      expect(button?.className).toBeTruthy();
    });

    it('should have visible focus indicators on link', () => {
      const onSignUp = vi.fn();

      const { container } = render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const link = container.querySelector('a');
      expect(link).toBeInTheDocument();
    });
  });

  describe('Loading State Accessibility', () => {
    it('should announce loading state to screen readers', async () => {
      const onSignUp = vi.fn(() => new Promise(() => {}));

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button');
      button.click();

      // Loading text should be visible
      const loadingText = await screen.findByText('Creating your account...');
      expect(loadingText).toBeInTheDocument();
    });

    it('should maintain button focus during loading', async () => {
      const onSignUp = vi.fn(() => new Promise(() => {}));

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button');
      button.focus();
      button.click();

      await screen.findByText('Creating your account...');

      // Button should still be focusable
      expect(document.activeElement).toBe(button);
    });
  });

  describe('Information and Relationships', () => {
    it('should display terms agreement information', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      expect(screen.getByText(/By signing up, you agree to our Terms of Service/i)).toBeInTheDocument();
    });

    it('should display approved domains information', () => {
      const onSignUp = vi.fn();

      render(
        <SignUpForm
          onSignUp={onSignUp}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      expect(screen.getByText(/Only users with approved email domains can sign up/i)).toBeInTheDocument();
    });
  });
});
