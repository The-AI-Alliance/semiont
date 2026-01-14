/**
 * Tests for AuthErrorDisplay component
 *
 * Simple tests for a simple component. No mocking required.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthErrorDisplay } from '../components/AuthErrorDisplay';

// Mock Link component for testing
const MockLink: React.ComponentType<{ href: string; children: React.ReactNode; className?: string }> = ({ href, children, className }) => (
  <a href={href} className={className}>{children}</a>
);

const mockTranslations = {
  pageTitle: 'Authentication Error',
  tryAgain: 'Try signing in again',
  errorConfiguration: 'There is a problem with the server configuration.',
  errorAccessDenied: 'Access denied. Your email domain is not allowed.',
  errorVerification: 'The verification link is invalid or has expired.',
  errorGeneric: 'An authentication error occurred. Please try again.',
};

describe('AuthErrorDisplay', () => {
  describe('Error Message Display', () => {
    it('displays Configuration error message', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="Configuration" translations={mockTranslations} />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
      expect(screen.getByText('There is a problem with the server configuration.')).toBeInTheDocument();
    });

    it('displays AccessDenied error message', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="AccessDenied" translations={mockTranslations} />);

      expect(screen.getByText('Access denied. Your email domain is not allowed.')).toBeInTheDocument();
    });

    it('displays Verification error message', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="Verification" translations={mockTranslations} />);

      expect(screen.getByText('The verification link is invalid or has expired.')).toBeInTheDocument();
    });

    it('displays generic error message for unknown error type', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="UnknownError" translations={mockTranslations} />);

      expect(screen.getByText('An authentication error occurred. Please try again.')).toBeInTheDocument();
    });

    it('displays generic error message when errorType is null', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType={null} translations={mockTranslations} />);

      expect(screen.getByText('An authentication error occurred. Please try again.')).toBeInTheDocument();
    });
  });

  describe('UI Elements', () => {
    it('renders the page title', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="AccessDenied" translations={mockTranslations} />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
    });

    it('renders error message in styled container', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="AccessDenied" translations={mockTranslations} />);

      const errorText = screen.getByText('Access denied. Your email domain is not allowed.');

      expect(errorText).toHaveClass('semiont-collaboration-panel__status-text');
    });

    it('renders try again link', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="AccessDenied" translations={mockTranslations} />);

      const link = screen.getByRole('link', { name: 'Try signing in again' });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/auth/signin');
    });
  });

  describe('Accessibility', () => {
    it('has proper heading hierarchy', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="AccessDenied" translations={mockTranslations} />);

      const heading = screen.getByRole('heading', { name: 'Authentication Error' });
      expect(heading).toBeInTheDocument();
      expect(heading.tagName).toBe('H2');
    });

    it('has accessible link to sign-in', () => {
      render(<AuthErrorDisplay Link={MockLink} errorType="AccessDenied" translations={mockTranslations} />);

      const link = screen.getByRole('link', { name: 'Try signing in again' });
      expect(link).toBeInTheDocument();
    });
  });
});
