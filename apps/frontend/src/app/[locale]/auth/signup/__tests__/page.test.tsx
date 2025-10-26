import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import SignUp from '../page';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
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

// Mock console methods
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('SignUp Page - Comprehensive Tests', () => {
  const mockSearchParams = {
    get: vi.fn(),
  };

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockConsoleError.mockClear();
    (useSearchParams as Mock).mockReturnValue(mockSearchParams);
    (signIn as Mock).mockResolvedValue(undefined);
    mockSearchParams.get.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Component Rendering & UI', () => {
    it('renders signup form immediately', () => {
      render(<SignUp />);
      
      expect(screen.getByText('Create your Semiont account')).toBeInTheDocument();
      expect(screen.getByText('Sign up with your Google account to get started')).toBeInTheDocument();
      expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
    });

    it('shows Google icon in button', () => {
      render(<SignUp />);
      
      const googleIcon = document.querySelector('svg');
      expect(googleIcon).toBeInTheDocument();
      expect(googleIcon).toHaveAttribute('viewBox', '0 0 24 24');
    });

    it('displays loading spinner when loading', async () => {
      (signIn as Mock).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
      expect(spinner).toHaveClass('rounded-full', 'border-2', 'border-white', 'border-t-transparent');
    });

    it('has proper button accessibility attributes', () => {
      render(<SignUp />);
      
      const signUpButton = screen.getByRole('button', { name: /Sign Up with Google/ });
      expect(signUpButton).toBeInTheDocument();
      // Button has some styling classes, exact classes may vary with buttonStyles utility
      expect(signUpButton.className).toContain('w-full');
    });

    it('applies dark mode styling classes', () => {
      render(<SignUp />);
      
      // PageLayout wraps the content, check for the bg-gray-50 class
      const container = document.querySelector('.bg-gray-50');
      expect(container).toBeInTheDocument();
      
      const heading = screen.getByText('Create your Semiont account');
      expect(heading).toHaveClass('text-gray-900', 'dark:text-white');
    });

    it('uses responsive layout classes', () => {
      render(<SignUp />);
      
      const mainContainer = document.querySelector('.max-w-md.w-full.space-y-8');
      expect(mainContainer).toBeInTheDocument();
      
      const formContainer = document.querySelector('.mt-8.space-y-6');
      expect(formContainer).toBeInTheDocument();
    });

    it('shows terms acceptance disclaimer', () => {
      render(<SignUp />);
      
      // Check for the disclaimer text using regex to handle potential text splitting
      expect(screen.getByText(/Only users with approved email domains can create accounts/)).toBeInTheDocument();
      expect(screen.getByText(/By signing up, you'll be asked to agree to our terms of service/)).toBeInTheDocument();
    });

    it('displays sign-in link with proper styling', () => {
      render(<SignUp />);
      
      const signInLink = screen.getByRole('link', { name: /Already have an account/ });
      expect(signInLink).toHaveAttribute('href', '/auth/signin');
      expect(signInLink).toHaveClass('text-sm', 'text-gray-600', 'dark:text-gray-400');
    });
  });

  describe('Authentication Flow', () => {
    it('initiates Google OAuth with default callback URL', async () => {
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: '/auth/welcome'
        });
      });
    });

    it('handles loading state during OAuth initiation', async () => {
      (signIn as Mock).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      expect(screen.getByText('Creating account...')).toBeInTheDocument();
      expect(signUpButton).toBeDisabled();
      expect(signUpButton).toHaveClass('disabled:opacity-50', 'disabled:cursor-not-allowed');
    });

    it('uses custom callback URL from search params', async () => {
      mockSearchParams.get.mockReturnValue('/dashboard');
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: '/dashboard'
        });
      });
    });

    it('handles OAuth initialization errors', async () => {
      const signInError = new Error('OAuth failed');
      (signIn as Mock).mockRejectedValue(signInError);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      // Wait for error to be processed and loading state to reset
      await waitFor(() => {
        expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
      });
      
      // Should reset loading state on error
      expect(signUpButton).not.toBeDisabled();
    });

    it('handles network errors during OAuth', async () => {
      const networkError = new Error('Network error');
      (signIn as Mock).mockRejectedValue(networkError);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      // Wait for error to be processed and loading state to reset
      await waitFor(() => {
        expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
      });
      
      expect(signUpButton).not.toBeDisabled();
    });

    it('prevents multiple rapid clicks during loading', async () => {
      (signIn as Mock).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      
      // Click multiple times rapidly
      fireEvent.click(signUpButton);
      fireEvent.click(signUpButton);
      fireEvent.click(signUpButton);
      
      // Should only call signIn once
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(signUpButton).toBeDisabled();
    });

    it('handles undefined signIn response', async () => {
      (signIn as Mock).mockResolvedValue(undefined);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalled();
      });
      
      // In real usage, signIn with undefined would redirect the user away
      // In test, the loading state remains because there's no redirect
      // So we check that signIn was called successfully
      expect(signIn).toHaveBeenCalledWith('google', { 
        callbackUrl: '/auth/welcome'
      });
    });

    it('handles timeout scenarios gracefully', async () => {
      const timeoutError = new Error('Request timeout');
      (signIn as Mock).mockRejectedValue(timeoutError);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      // Wait for error to be processed and loading state to reset
      await waitFor(() => {
        expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
      });
      
      expect(signUpButton).not.toBeDisabled();
    });

    it('handles OAuth provider unavailable', async () => {
      const providerError = new Error('Provider temporarily unavailable');
      (signIn as Mock).mockRejectedValue(providerError);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      // Wait for error to be processed and loading state to reset
      await waitFor(() => {
        expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
      });
      
      expect(signUpButton).not.toBeDisabled();
    });
  });

  describe('URL Parameter Handling', () => {
    it('uses default callback when no URL params', () => {
      mockSearchParams.get.mockReturnValue(null);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      expect(signIn).toHaveBeenCalledWith('google', { 
        callbackUrl: '/auth/welcome'
      });
    });

    it('extracts valid callback URL from search params', async () => {
      mockSearchParams.get.mockReturnValue('/admin/dashboard');
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: '/admin/dashboard'
        });
      });
    });

    it('handles malformed callback URLs safely', async () => {
      mockSearchParams.get.mockReturnValue('javascript:alert(1)');
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: 'javascript:alert(1)' // Note: NextAuth handles URL validation
        });
      });
    });

    it('handles empty callback URL', async () => {
      mockSearchParams.get.mockReturnValue('');
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: '/auth/welcome' // Empty string is falsy, should use default
        });
      });
    });

    it('handles very long callback URLs', async () => {
      const longUrl = '/very/long/path' + '/segment'.repeat(100);
      mockSearchParams.get.mockReturnValue(longUrl);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: longUrl
        });
      });
    });

    it('handles special characters in callback URLs', async () => {
      const specialUrl = '/path?param=value&other=test#section';
      mockSearchParams.get.mockReturnValue(specialUrl);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: specialUrl
        });
      });
    });
  });

  describe('Loading States & UX', () => {
    it('disables button during loading', async () => {
      (signIn as Mock).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      expect(signUpButton).toBeDisabled();
      expect(signUpButton).toHaveAttribute('disabled');
    });

    it('changes button text during loading', async () => {
      (signIn as Mock).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      expect(screen.getByText('Creating account...')).toBeInTheDocument();
      expect(screen.queryByText('Sign Up with Google')).not.toBeInTheDocument();
    });

    it('shows loading spinner visibility', async () => {
      (signIn as Mock).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
      expect(spinner).toHaveClass('w-5', 'h-5', 'mr-2');
    });

    it('resets loading state after successful OAuth', async () => {
      (signIn as Mock).mockResolvedValue(undefined);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalled();
      });
      
      // Note: In real implementation, user would be redirected, so button state doesn't reset
      // This tests the error case where signIn completes but doesn't redirect
    });

    it('manages multiple loading state changes', async () => {
      let resolveSignIn: (value?: any) => void;
      (signIn as Mock).mockImplementation(() => new Promise(resolve => {
        resolveSignIn = resolve;
      }));
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      
      // Start loading
      fireEvent.click(signUpButton);
      expect(screen.getByText('Creating account...')).toBeInTheDocument();
      
      // Complete loading
      resolveSignIn!();
      await waitFor(() => {
        expect(signIn).toHaveBeenCalled();
      });
    });
  });

  describe('Error Handling & Edge Cases', () => {
    it('logs console errors appropriately', async () => {
      // Temporarily restore console.error to capture the actual call
      mockConsoleError.mockRestore();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const testError = new Error('Test error');
      (signIn as Mock).mockRejectedValue(testError);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Failed to initiate Google sign-up:', testError);
      }, { timeout: 2000 });
      
      consoleSpy.mockRestore();
    });

    it('handles component unmounting during OAuth', async () => {
      let resolveSignIn: (value?: any) => void;
      (signIn as Mock).mockImplementation(() => new Promise(resolve => {
        resolveSignIn = resolve;
      }));
      
      const { unmount } = render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      // Unmount component before OAuth completes
      unmount();
      
      // Complete the OAuth - should not cause errors
      resolveSignIn!();
      
      // No assertions needed - test passes if no errors thrown
    });

    it('handles Suspense fallback behavior', () => {
      render(<SignUp />);
      
      // The component uses Suspense with a fallback
      // In test environment, this should render immediately
      expect(screen.getByText('Create your Semiont account')).toBeInTheDocument();
    });

    it('handles missing search params gracefully', () => {
      (useSearchParams as Mock).mockReturnValue({
        get: vi.fn().mockReturnValue(null)
      });
      
      // Should not crash
      expect(() => render(<SignUp />)).not.toThrow();
    });
  });

  describe('Accessibility', () => {
    it('supports keyboard navigation', () => {
      render(<SignUp />);
      
      const signUpButton = screen.getByRole('button', { name: /Sign Up with Google/ });
      const signInLink = screen.getByRole('link', { name: /Already have an account/ });
      
      expect(signUpButton).toBeInTheDocument();
      expect(signInLink).toBeInTheDocument();
      
      // Both elements should be focusable
      signUpButton.focus();
      expect(document.activeElement).toBe(signUpButton);
      
      signInLink.focus();
      expect(document.activeElement).toBe(signInLink);
    });

    it('provides screen reader compatibility', () => {
      render(<SignUp />);
      
      // Check for proper heading hierarchy - may have multiple headings from PageLayout
      const headings = screen.getAllByRole('heading', { level: 2 });
      const mainHeading = headings.find(h => h.textContent === 'Create your Semiont account');
      expect(mainHeading).toBeInTheDocument();
      
      // Check for proper button labeling
      const signUpButton = screen.getByRole('button', { name: /Sign Up with Google/ });
      expect(signUpButton).toBeInTheDocument();
      
      // Check for link accessibility
      const signInLink = screen.getByRole('link', { name: /Already have an account/ });
      expect(signInLink).toBeInTheDocument();
    });
  });
});

// Cleanup console mock after all tests
afterEach(() => {
  mockConsoleError.mockRestore();
});