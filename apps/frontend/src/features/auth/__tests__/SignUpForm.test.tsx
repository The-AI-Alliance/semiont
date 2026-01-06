/**
 * Tests for SignUpForm component
 *
 * Note: These tests are SIMPLE because the component is properly isolated.
 * No Next.js mocking required. No SessionProvider required.
 * Just pure React component testing.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SignUpForm } from '../components/SignUpForm';

const mockTranslations = {
  pageTitle: 'Join Semiont',
  signUpPrompt: 'Create your knowledge workspace account',
  signUpWithGoogle: 'Continue with Google',
  creatingAccount: 'Creating your account...',
  approvedDomainsInfo: 'Only users with approved email domains can sign up',
  termsAgreement: 'By signing up, you agree to our Terms of Service',
  alreadyHaveAccount: 'Already have an account? Sign In',
};

describe('SignUpForm', () => {
  describe('Rendering', () => {
    it('renders the sign-up form with all elements', () => {
      const onSignUp = vi.fn();
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      expect(screen.getByText('Join Semiont')).toBeInTheDocument();
      expect(screen.getByText('Create your knowledge workspace account')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeInTheDocument();
      expect(screen.getByText(/Only users with approved email domains/i)).toBeInTheDocument();
      expect(screen.getByText(/Already have an account/i)).toBeInTheDocument();
    });

    it('renders the Google icon', () => {
      const onSignUp = vi.fn();
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const button = screen.getByRole('button');
      const svg = button.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('Sign-Up Interaction', () => {
    it('calls onSignUp when button is clicked', async () => {
      const onSignUp = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const button = screen.getByRole('button', { name: /Continue with Google/i });
      fireEvent.click(button);

      expect(onSignUp).toHaveBeenCalledTimes(1);
    });

    it('shows loading state while signing up', async () => {
      const onSignUp = vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      // Should show loading text
      expect(screen.getByText('Creating your account...')).toBeInTheDocument();

      // Button should be disabled
      expect(button).toBeDisabled();

      // Should show spinner instead of Google icon
      const spinner = button.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();

      await waitFor(() => expect(onSignUp).toHaveBeenCalled());
    });

    it('disables button during loading', async () => {
      const onSignUp = vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(button).toBeDisabled();

      await waitFor(() => expect(onSignUp).toHaveBeenCalled());
    });
  });

  describe('Error Handling', () => {
    it('handles sign-up errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onSignUp = vi.fn().mockRejectedValue(new Error('OAuth failed'));
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Failed to initiate Google sign-up:',
          expect.any(Error)
        );
      });

      // Should re-enable button after error
      await waitFor(() => {
        expect(button).not.toBeDisabled();
      });

      consoleErrorSpy.mockRestore();
    });

    it('resets loading state after error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onSignUp = vi.fn().mockRejectedValue(new Error('OAuth failed'));
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      // Wait for error
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      // Should show original button text again
      expect(screen.getByText('Continue with Google')).toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Accessibility', () => {
    it('has accessible button', () => {
      const onSignUp = vi.fn();
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const button = screen.getByRole('button', { name: /Continue with Google/i });
      expect(button).toBeInTheDocument();
    });

    it('has accessible link to sign-in', () => {
      const onSignUp = vi.fn();
      render(<SignUpForm onSignUp={onSignUp} translations={mockTranslations} />);

      const link = screen.getByRole('link', { name: /Already have an account/i });
      expect(link).toHaveAttribute('href', '/auth/signin');
    });
  });
});
