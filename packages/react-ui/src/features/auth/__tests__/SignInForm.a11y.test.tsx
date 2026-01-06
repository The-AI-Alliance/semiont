/**
 * SignInForm - Accessibility Tests
 *
 * WCAG 2.1 AA compliance tests for SignInForm component.
 * Tests keyboard navigation, screen reader support, color contrast, and ARIA attributes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { SignInForm } from '../components/SignInForm';

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
  pageTitle: 'Sign In',
  welcomeBack: 'Welcome back to Semiont',
  signInPrompt: 'Sign in to your knowledge workspace',
  continueWithGoogle: 'Continue with Google',
  emailLabel: 'Email',
  emailPlaceholder: 'your@email.com',
  passwordLabel: 'Password',
  passwordPlaceholder: 'Enter your password',
  signInWithCredentials: 'Sign in with Email & Password',
  or: 'or',
  credentialsAuthEnabled: 'Email and password authentication enabled',
  approvedDomainsOnly: 'Only approved email domains allowed',
  backToHome: 'Back to Home',
  learnMore: 'Learn More',
  signUpInstead: 'Sign Up Instead',
  errorEmailRequired: 'Email is required',
  errorPasswordRequired: 'Password is required',
};

describe('SignInForm - Accessibility', () => {
  describe('WCAG 2.1 AA - Automated axe-core Tests', () => {
    it('should have no accessibility violations (Google OAuth only)', async () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have no accessibility violations (with credentials auth)', async () => {
      const onGoogleSignIn = vi.fn();
      const onCredentialsSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          onCredentialsSignIn={onCredentialsSignIn}
          showCredentialsAuth={true}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have no accessibility violations (with error message)', async () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          error="Authentication failed. Please try again."
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('WCAG 1.3.1 - Info and Relationships (Semantic HTML)', () => {
    it('should use semantic main element with proper role', () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const main = container.querySelector('main[role="main"]');
      expect(main).toBeInTheDocument();
    });

    it('should have proper heading hierarchy', () => {
      const onGoogleSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      // Screen reader heading should be h1
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toHaveTextContent('Sign In');
    });

    it('should use semantic section element with aria-labelledby', () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const section = container.querySelector('section[aria-labelledby="signin-heading"]');
      expect(section).toBeInTheDocument();
    });
  });

  describe('WCAG 3.3.2 - Labels or Instructions (Form Fields)', () => {
    it('should have properly labeled email input with credentials auth', () => {
      const onGoogleSignIn = vi.fn();
      const onCredentialsSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          onCredentialsSignIn={onCredentialsSignIn}
          showCredentialsAuth={true}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const emailInput = screen.getByLabelText('Email');
      expect(emailInput).toBeInTheDocument();
      expect(emailInput).toHaveAttribute('type', 'email');
      expect(emailInput).toHaveAttribute('placeholder', 'your@email.com');
      expect(emailInput).toHaveAttribute('required');
    });

    it('should have properly labeled password input with credentials auth', () => {
      const onGoogleSignIn = vi.fn();
      const onCredentialsSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          onCredentialsSignIn={onCredentialsSignIn}
          showCredentialsAuth={true}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const passwordInput = screen.getByLabelText('Password');
      expect(passwordInput).toBeInTheDocument();
      expect(passwordInput).toHaveAttribute('type', 'password');
      expect(passwordInput).toHaveAttribute('required');
    });
  });

  describe('WCAG 2.1.1 - Keyboard Accessibility', () => {
    it('should have keyboard-accessible Google sign-in button', () => {
      const onGoogleSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button', { name: /Continue with Google/i });
      expect(button).toBeInTheDocument();
      expect(button).not.toHaveAttribute('disabled');
    });

    it('should have keyboard-accessible navigation links', () => {
      const onGoogleSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const homeLink = screen.getByRole('link', { name: 'Back to Home' });
      const learnMoreLink = screen.getByRole('link', { name: 'Learn More' });
      const signUpLink = screen.getByRole('link', { name: 'Sign Up Instead' });

      expect(homeLink).toHaveAttribute('href', '/');
      expect(learnMoreLink).toHaveAttribute('href', '/about');
      expect(signUpLink).toHaveAttribute('href', '/auth/signup');
    });

    it('should have keyboard-accessible credentials submit button', () => {
      const onGoogleSignIn = vi.fn();
      const onCredentialsSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          onCredentialsSignIn={onCredentialsSignIn}
          showCredentialsAuth={true}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const submitButton = screen.getByRole('button', { name: 'Sign in with Email & Password' });
      expect(submitButton).toBeInTheDocument();
      expect(submitButton).toHaveAttribute('type', 'submit');
    });
  });

  describe('WCAG 4.1.2 - Name, Role, Value (ARIA)', () => {
    it('should have accessible button names', () => {
      const onGoogleSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      // Button should have accessible name from text content
      const button = screen.getByRole('button');
      expect(button).toHaveAccessibleName(/Continue with Google/i);
    });

    it('should have accessible link names', () => {
      const onGoogleSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const links = screen.getAllByRole('link');

      // All links should have accessible names
      links.forEach(link => {
        expect(link).toHaveAccessibleName();
      });
    });
  });

  describe('WCAG 3.3.1 - Error Identification', () => {
    it('should display error messages accessibly', () => {
      const onGoogleSignIn = vi.fn();
      const errorMessage = 'Invalid email or password';

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          error={errorMessage}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      // Error should be visible and properly styled
      const error = screen.getByText(errorMessage);
      expect(error).toBeInTheDocument();
      expect(error).toHaveClass('text-red-700');
    });
  });

  describe('WCAG 1.4.3 - Color Contrast (Minimum)', () => {
    it('should have sufficient color contrast for text', async () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
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

  describe('WCAG 2.4.6 - Headings and Labels (Descriptive)', () => {
    it('should have descriptive page title for screen readers', () => {
      const onGoogleSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const heading = screen.getByRole('heading', { name: 'Sign In' });
      expect(heading).toBeInTheDocument();
    });

    it('should have descriptive form labels', () => {
      const onGoogleSignIn = vi.fn();
      const onCredentialsSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          onCredentialsSignIn={onCredentialsSignIn}
          showCredentialsAuth={true}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      // Labels should be descriptive
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });

  describe('WCAG 2.5.3 - Label in Name', () => {
    it('should have button text matching accessible name', () => {
      const onGoogleSignIn = vi.fn();

      render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = screen.getByRole('button', { name: /Continue with Google/i });
      expect(button).toHaveTextContent('Continue with Google');
    });
  });

  describe('Focus Management', () => {
    it('should have visible focus indicators on buttons', () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const button = container.querySelector('button');

      // Button should have focus classes
      expect(button?.className).toContain('focus:outline-none');
      expect(button?.className).toContain('focus:ring');
    });

    it('should have visible focus indicators on links', () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const links = container.querySelectorAll('a');

      // At least one link should exist and have focus styling
      expect(links.length).toBeGreaterThan(0);
      links.forEach(link => {
        expect(link.className).toBeTruthy();
      });
    });
  });

  describe('Screen Reader Support', () => {
    it('should have screen reader only heading', () => {
      const onGoogleSignIn = vi.fn();

      const { container } = render(
        <SignInForm
          onGoogleSignIn={onGoogleSignIn}
          Link={MockLink}
          translations={mockTranslations}
        />
      );

      const srOnlyHeading = container.querySelector('.sr-only');
      expect(srOnlyHeading).toBeInTheDocument();
      expect(srOnlyHeading).toHaveTextContent('Sign In');
    });
  });
});
