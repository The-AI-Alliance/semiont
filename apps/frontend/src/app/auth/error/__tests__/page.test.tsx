import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import React from 'react';
import { render, screen } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';
import AuthError from '../page';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

describe('AuthError Page', () => {
  const mockSearchParams = {
    get: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useSearchParams as Mock).mockReturnValue(mockSearchParams);
  });

  describe('Error Display', () => {
    it('shows correct error message for Configuration error', () => {
      mockSearchParams.get.mockReturnValue('Configuration');

      render(<AuthError />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
      expect(screen.getByText('There is a problem with the server configuration.')).toBeInTheDocument();
    });

    it('shows correct error message for AccessDenied error', () => {
      mockSearchParams.get.mockReturnValue('AccessDenied');

      render(<AuthError />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
      expect(screen.getByText('Your email domain is not allowed for this application.')).toBeInTheDocument();
    });

    it('shows correct error message for Verification error', () => {
      mockSearchParams.get.mockReturnValue('Verification');

      render(<AuthError />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
      expect(screen.getByText('The verification token has expired or has already been used.')).toBeInTheDocument();
    });

    it('shows generic message for unknown errors', () => {
      mockSearchParams.get.mockReturnValue('UnknownError');

      render(<AuthError />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
      expect(screen.getByText('An authentication error occurred.')).toBeInTheDocument();
    });

    it('shows generic message when no error parameter', () => {
      mockSearchParams.get.mockReturnValue(null);

      render(<AuthError />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
      expect(screen.getByText('An authentication error occurred.')).toBeInTheDocument();
    });

    it('shows generic message for empty error parameter', () => {
      mockSearchParams.get.mockReturnValue('');

      render(<AuthError />);

      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
      expect(screen.getByText('An authentication error occurred.')).toBeInTheDocument();
    });
  });

  describe('Error Recovery', () => {
    it('displays link to try signing in again', () => {
      mockSearchParams.get.mockReturnValue('AccessDenied');

      render(<AuthError />);

      const signInLink = screen.getByRole('link', { name: 'Try signing in again' });
      expect(signInLink).toBeInTheDocument();
      expect(signInLink).toHaveAttribute('href', '/auth/signin');
    });

    it('shows sign-in link for all error types', () => {
      const errorTypes = ['Configuration', 'AccessDenied', 'Verification', 'UnknownError', null];

      errorTypes.forEach(errorType => {
        mockSearchParams.get.mockReturnValue(errorType);
        
        const { unmount } = render(<AuthError />);
        
        const signInLink = screen.getByRole('link', { name: 'Try signing in again' });
        expect(signInLink).toBeInTheDocument();
        expect(signInLink).toHaveAttribute('href', '/auth/signin');
        
        unmount();
      });
    });

    it('applies correct CSS classes to sign-in link', () => {
      mockSearchParams.get.mockReturnValue('AccessDenied');

      render(<AuthError />);

      const signInLink = screen.getByRole('link', { name: 'Try signing in again' });
      expect(signInLink).toHaveClass('text-blue-600', 'hover:text-blue-500', 'dark:text-blue-400', 'dark:hover:text-blue-300');
    });
  });

  describe('Visual Structure', () => {
    it('displays error in styled error box', () => {
      mockSearchParams.get.mockReturnValue('AccessDenied');

      render(<AuthError />);

      const errorMessage = screen.getByText('Your email domain is not allowed for this application.');
      const errorContainer = errorMessage.closest('.bg-red-50');
      
      expect(errorContainer).toHaveClass('bg-red-50', 'dark:bg-red-900/20', 'border', 'border-red-200', 'dark:border-red-800');
    });

    it('applies dark mode classes correctly', () => {
      mockSearchParams.get.mockReturnValue('Configuration');

      render(<AuthError />);

      const heading = screen.getByText('Authentication Error');
      expect(heading).toHaveClass('text-gray-900', 'dark:text-white');
    });

    it('uses proper layout structure', () => {
      mockSearchParams.get.mockReturnValue('Verification');

      render(<AuthError />);

      // Check that the main container has proper layout classes
      const container = screen.getByText('Authentication Error').closest('.min-h-screen');
      expect(container).toHaveClass('min-h-screen', 'flex', 'flex-col');
    });
  });

  describe('Loading and Suspense', () => {
    it('renders within Suspense boundary', () => {
      mockSearchParams.get.mockReturnValue('AccessDenied');

      render(<AuthError />);

      // The component should render successfully
      expect(screen.getByText('Authentication Error')).toBeInTheDocument();
    });

    it('handles rapid error parameter changes', () => {
      // Start with one error
      mockSearchParams.get.mockReturnValue('Configuration');
      const { rerender } = render(<AuthError />);
      
      expect(screen.getByText('There is a problem with the server configuration.')).toBeInTheDocument();
      
      // Change to different error
      mockSearchParams.get.mockReturnValue('AccessDenied');
      rerender(<AuthError />);
      
      expect(screen.getByText('Your email domain is not allowed for this application.')).toBeInTheDocument();
      expect(screen.queryByText('There is a problem with the server configuration.')).not.toBeInTheDocument();
    });
  });

  describe('Error Message Function Coverage', () => {
    it('covers all defined error cases', () => {
      const testCases = [
        { error: 'Configuration', expectedMessage: 'There is a problem with the server configuration.' },
        { error: 'AccessDenied', expectedMessage: 'Your email domain is not allowed for this application.' },
        { error: 'Verification', expectedMessage: 'The verification token has expired or has already been used.' },
        { error: 'RandomError', expectedMessage: 'An authentication error occurred.' },
        { error: null, expectedMessage: 'An authentication error occurred.' },
      ];

      testCases.forEach(({ error, expectedMessage }) => {
        mockSearchParams.get.mockReturnValue(error);
        
        const { unmount } = render(<AuthError />);
        
        expect(screen.getByText(expectedMessage)).toBeInTheDocument();
        
        unmount();
      });
    });
  });
});