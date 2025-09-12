import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import SignIn from '../page';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
  useSession: vi.fn(() => ({
    data: null,
    status: 'unauthenticated',
  })),
  SessionProvider: ({ children }: any) => children,
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

describe('SignIn Page', () => {
  const mockSearchParams = {
    get: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useSearchParams as vi.Mock).mockReturnValue(mockSearchParams);
    mockSearchParams.get.mockImplementation((param) => {
      if (param === 'callbackUrl') return null;
      if (param === 'error') return null;
      return null;
    });
  });

  describe('Component Rendering', () => {
    it('renders sign-in form with correct heading and description', () => {
      render(<SignIn />);
      
      expect(screen.getByText('Sign in to Semiont')).toBeInTheDocument();
      expect(screen.getByText('Semantic Knowledge Platform')).toBeInTheDocument();
    });

    it('shows Google sign-in button', () => {
      render(<SignIn />);
      
      const signInButton = screen.getByRole('button', { name: /Continue with Google/i });
      expect(signInButton).toBeInTheDocument();
    });

    it('shows link to sign-up page', () => {
      render(<SignIn />);
      
      const signUpLink = screen.getByRole('link', { name: /Don't have an account\? Sign up instead/i });
      expect(signUpLink).toBeInTheDocument();
      expect(signUpLink).toHaveAttribute('href', '/auth/signup');
    });

    it('shows domain restriction notice', () => {
      render(<SignIn />);
      
      expect(screen.getByText('Only users with approved email domains can sign in')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('displays error message for Signin error', () => {
      mockSearchParams.get.mockImplementation((param) => {
        if (param === 'error') return 'Signin';
        return null;
      });

      render(<SignIn />);
      
      expect(screen.getByText('Authentication failed. Please try again.')).toBeInTheDocument();
    });

    it('displays error message for OAuthSignin error', () => {
      mockSearchParams.get.mockImplementation((param) => {
        if (param === 'error') return 'OAuthSignin';
        return null;
      });

      render(<SignIn />);
      
      expect(screen.getByText('Error connecting to Google. Please try again.')).toBeInTheDocument();
    });

    it('displays error message for OAuthCallback error', () => {
      mockSearchParams.get.mockImplementation((param) => {
        if (param === 'error') return 'OAuthCallback';
        return null;
      });

      render(<SignIn />);
      
      expect(screen.getByText('Your email domain is not allowed for this application.')).toBeInTheDocument();
    });

    it('displays error message for OAuthCreateAccount error', () => {
      mockSearchParams.get.mockImplementation((param) => {
        if (param === 'error') return 'OAuthCreateAccount';
        return null;
      });

      render(<SignIn />);
      
      expect(screen.getByText('Failed to create account. Please contact support.')).toBeInTheDocument();
    });

    it('displays generic error message for unknown error types', () => {
      mockSearchParams.get.mockImplementation((param) => {
        if (param === 'error') return 'UnknownError';
        return null;
      });

      render(<SignIn />);
      
      expect(screen.getByText('An authentication error occurred. Please try again.')).toBeInTheDocument();
    });

    it('does not show error message when no error parameter', () => {
      render(<SignIn />);
      
      const errorElements = screen.queryAllByText(/failed|error/i);
      // Only the potential error in sign-in button handler should exist, not visible error messages
      expect(screen.queryByText('Authentication failed. Please try again.')).not.toBeInTheDocument();
    });
  });

  describe('User Interactions', () => {
    it('initiates Google OAuth flow when button clicked', async () => {
      render(<SignIn />);
      
      const signInButton = screen.getByRole('button', { name: /Continue with Google/i });
      fireEvent.click(signInButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { callbackUrl: '/' });
      });
    });

    it('passes correct callback URL from search params', async () => {
      mockSearchParams.get.mockImplementation((param) => {
        if (param === 'callbackUrl') return '/dashboard';
        return null;
      });

      render(<SignIn />);
      
      const signInButton = screen.getByRole('button', { name: /Continue with Google/i });
      fireEvent.click(signInButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });
      });
    });

    it('uses default callback URL when none provided', async () => {
      render(<SignIn />);
      
      const signInButton = screen.getByRole('button', { name: /Continue with Google/i });
      fireEvent.click(signInButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { callbackUrl: '/' });
      });
    });

    it('handles errors during sign-in attempt', async () => {
      const signInError = new Error('Sign-in failed');
      (signIn as vi.Mock).mockRejectedValueOnce(signInError);

      render(<SignIn />);
      
      const signInButton = screen.getByRole('button', { name: /Continue with Google/i });
      fireEvent.click(signInButton);
      
      await waitFor(() => {
        expect(screen.getByText('Failed to initiate Google sign-in. Please try again.')).toBeInTheDocument();
      });
    });

    it('preserves existing error when sign-in fails', async () => {
      // Set an initial error from URL params
      mockSearchParams.get.mockImplementation((param) => {
        if (param === 'error') return 'OAuthCallback';
        return null;
      });

      const signInError = new Error('Sign-in failed');
      (signIn as vi.Mock).mockRejectedValueOnce(signInError);

      render(<SignIn />);
      
      // Should show initial error
      expect(screen.getByText('Your email domain is not allowed for this application.')).toBeInTheDocument();
      
      const signInButton = screen.getByRole('button', { name: /Continue with Google/i });
      fireEvent.click(signInButton);
      
      await waitFor(() => {
        // Should now show the new error
        expect(screen.getByText('Failed to initiate Google sign-in. Please try again.')).toBeInTheDocument();
      });
    });
  });

  describe('Loading and Suspense', () => {
    it('renders within Suspense boundary', () => {
      render(<SignIn />);
      
      // The component should render successfully
      expect(screen.getByText('Sign in to Semiont')).toBeInTheDocument();
    });
  });
});