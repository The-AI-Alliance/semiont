import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest'
import React from 'react';
import { renderWithProviders, screen, fireEvent, waitFor, cleanup } from '@/test-utils';
import '@testing-library/jest-dom';
import { signIn, useSession, signOut } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/routing';
import { useAuthApi } from '@semiont/react-ui';
import { server } from '@/mocks/server';
import { http, HttpResponse } from 'msw';

// Test components
import SignUp from '../signup/page';
import Welcome from '../welcome/page';

// Mock next-auth functions (keep SessionProvider from test-utils)
vi.mock('next-auth/react', async () => {
  const actual = await vi.importActual('next-auth/react');
  return {
    ...actual,
    signIn: vi.fn(),
    signOut: vi.fn(),
    useSession: vi.fn(() => ({
      data: null,
      status: 'unauthenticated',
    })),
  };
});

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

// Mock @/i18n/routing
vi.mock('@/i18n/routing', () => ({
  useRouter: vi.fn(),
  Link: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

// Mock the useAuthApi hook to avoid ky HTTP client issues in vitest
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    useAuthApi: vi.fn(),
  };
});

describe('Sign-Up Flow Integration Tests', () => {
  const mockRouter = {
    push: vi.fn(),
  };

  const mockSearchParams = {
    get: vi.fn(),
  };

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    (useRouter as Mock).mockReturnValue(mockRouter);
    (useSearchParams as Mock).mockReturnValue(mockSearchParams);
    mockSearchParams.get.mockReturnValue(null);

    // Mock useAuthApi to avoid ky HTTP client issues in vitest
    (useAuthApi as Mock).mockReturnValue({
      me: {
        useQuery: () => ({
          data: { termsAcceptedAt: null },
          isLoading: false,
          error: null,
        }),
      },
      acceptTerms: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ success: true }),
          isPending: false,
          isError: false,
          error: null,
        }),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe('Complete New User Journey', () => {
    it('should handle complete sign-up flow for new user', async () => {
      // Step 1: Start at signup page
      (signIn as Mock).mockResolvedValue(undefined);
      
      const { unmount: unmountSignup } = render(<SignUp />);
      
      expect(screen.getByText('Create your Semiont account')).toBeInTheDocument();
      expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
      
      // User clicks sign up
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: '/auth/welcome'
        });
      });
      
      unmountSignup();
      
      // Step 2: After OAuth, user arrives at welcome page
      const mockNewUserSession = {
        user: {
          name: 'Jane Doe',
          email: 'jane@example.com',
        },
        backendToken: 'new-user-token',
        isNewUser: true,
      };
      
      (useSession as Mock).mockReturnValue({
        data: mockNewUserSession,
        status: 'authenticated',
      });
      
      // Mock API response for terms not yet accepted
      server.use(
        http.get('*/api/users/me', () => {
          return HttpResponse.json({
            id: 'newuser123',
            email: 'jane@example.com',
            name: 'Jane Doe',
            termsAcceptedAt: null // New user hasn't accepted terms
          });
        })
      );
      
      const { unmount: unmountWelcome } = renderWithProviders(<Welcome />);
      
      // Should show welcome page with terms
      expect(screen.getByText('Welcome to Semiont, Jane!')).toBeInTheDocument();
      expect(screen.getByText('Terms of Service Summary')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Accept & Continue' })).toBeInTheDocument();
      
      // Step 3: User accepts terms
      const acceptButton = screen.getByRole('button', { name: 'Accept & Continue' });
      fireEvent.click(acceptButton);
      
      // Should show success state
      await waitFor(() => {
        expect(screen.getByText('Welcome to Semiont!')).toBeInTheDocument();
        expect(screen.getByText('Thanks for accepting our terms. Redirecting you to the app...')).toBeInTheDocument();
      });
      
      // Should redirect after timeout
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
      }, { timeout: 2000 });
      
      unmountWelcome();
    });

    it('should handle sign-up with custom callback URL', async () => {
      // Mock custom callback URL
      mockSearchParams.get.mockReturnValue('/admin/dashboard');
      (signIn as Mock).mockResolvedValue(undefined);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: '/admin/dashboard'
        });
      });
    });

    it('should redirect existing users directly to home', async () => {
      const mockExistingUserSession = {
        user: {
          name: 'Existing User',
          email: 'existing@example.com',
        },
        backendToken: 'existing-user-token',
        isNewUser: false, // Existing user
      };
      
      (useSession as Mock).mockReturnValue({
        data: mockExistingUserSession,
        status: 'authenticated',
      });
      
      renderWithProviders(<Welcome />);
      
      // Should redirect existing users immediately
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
      });
    });

    it('should handle users who already accepted terms', async () => {
      const mockUserSession = {
        user: {
          name: 'Terms Accepted User',
          email: 'accepted@example.com',
        },
        backendToken: 'accepted-user-token',
        isNewUser: true,
      };

      (useSession as Mock).mockReturnValue({
        data: mockUserSession,
        status: 'authenticated',
      });

      // Override useAuthApi mock to return user with accepted terms
      (useAuthApi as Mock).mockReturnValue({
        me: {
          useQuery: () => ({
            data: {
              id: 'accepteduser123',
              email: 'accepted@example.com',
              name: 'Terms Accepted User',
              termsAcceptedAt: '2024-01-01T00:00:00Z' // Already accepted
            },
            isLoading: false,
            error: null,
          }),
        },
        acceptTerms: {
          useMutation: () => ({
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
      });

      renderWithProviders(<Welcome />);

      // Should redirect to home since terms already accepted
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('Error Recovery Scenarios', () => {
    it('should handle OAuth failure and allow retry', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const oauthError = new Error('OAuth provider error');
      (signIn as Mock).mockRejectedValue(oauthError);

      render(<SignUp />);

      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);

      // Should show loading state initially
      expect(screen.getByText('Creating account...')).toBeInTheDocument();

      // After error, should reset to normal state
      await waitFor(() => {
        expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
        expect(signUpButton).not.toBeDisabled();
      });

      // User can retry
      (signIn as Mock).mockResolvedValue(undefined);
      fireEvent.click(signUpButton);

      await waitFor(() => {
        expect(signIn).toHaveBeenCalledTimes(2);
      });

      consoleErrorSpy.mockRestore();
    });

    it('should handle terms API failure and show error', async () => {
      const mockUserSession = {
        user: {
          name: 'API Error User',
          email: 'error@example.com',
        },
        backendToken: 'error-user-token',
        isNewUser: true,
      };

      (useSession as Mock).mockReturnValue({
        data: mockUserSession,
        status: 'authenticated',
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Override useAuthApi mock to make the mutation fail
      const mockMutateAsync = vi.fn().mockRejectedValue(new Error('API Error'));
      (useAuthApi as Mock).mockReturnValue({
        me: {
          useQuery: () => ({
            data: { termsAcceptedAt: null },
            isLoading: false,
            error: null,
          }),
        },
        acceptTerms: {
          useMutation: () => ({
            mutateAsync: mockMutateAsync,
            isPending: false,
            isError: false,
            error: null,
          }),
        },
      });

      renderWithProviders(<Welcome />);

      const acceptButton = screen.getByRole('button', { name: 'Accept & Continue' });
      fireEvent.click(acceptButton);

      // Should log error to console (toast is shown but hard to test in integration test)
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Terms acceptance error:', expect.any(Error));
      }, { timeout: 3000 });

      consoleErrorSpy.mockRestore();
    });

    it('should handle network errors gracefully', async () => {
      const networkError = new Error('Network connection failed');
      (signIn as Mock).mockRejectedValue(networkError);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(screen.getByText('Sign Up with Google')).toBeInTheDocument();
      });
    });

    it('should handle session loading states', async () => {
      (useSession as Mock).mockReturnValue({
        data: null,
        status: 'loading',
      });
      
      renderWithProviders(<Welcome />);
      
      // Should show loading state - may have multiple loading texts
      const loadingElements = screen.getAllByText('Loading...');
      expect(loadingElements.length).toBeGreaterThan(0);
      expect(mockRouter.push).not.toHaveBeenCalled();
    });
  });

  describe('Cross-Component State Management', () => {
    it('should maintain session state consistency', async () => {
      const consistentSession = {
        user: {
          name: 'Consistent User',
          email: 'consistent@example.com',
        },
        backendToken: 'consistent-token',
        isNewUser: true,
      };
      
      // Same session should work across components
      (useSession as Mock).mockReturnValue({
        data: consistentSession,
        status: 'authenticated',
      });
      
      const { unmount: unmountWelcome } = renderWithProviders(<Welcome />);
      
      expect(screen.getByText('Welcome to Semiont, Consistent!')).toBeInTheDocument();
      
      unmountWelcome();
      
      // Re-render with same session should work
      renderWithProviders(<Welcome />);
      expect(screen.getByText('Welcome to Semiont, Consistent!')).toBeInTheDocument();
    });

    it('should handle URL state preservation across navigation', async () => {
      const customCallback = '/custom/dashboard';
      mockSearchParams.get.mockReturnValue(customCallback);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(signIn).toHaveBeenCalledWith('google', { 
          callbackUrl: customCallback
        });
      });
    });

    it('should handle error state propagation', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const signInError = new Error('Authentication failed');
      (signIn as Mock).mockRejectedValue(signInError);
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to initiate Google sign-up:', signInError);
      });
      
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Performance and Memory Management', () => {
    it('should handle rapid component mounting/unmounting', () => {
      // Mount and unmount rapidly
      for (let i = 0; i < 5; i++) {
        const { unmount } = render(<SignUp />);
        expect(screen.getByText('Create your Semiont account')).toBeInTheDocument();
        unmount();
      }
      
      // Should not leak memory or cause errors
      expect(screen.queryByText('Create your Semiont account')).not.toBeInTheDocument();
    });

    it('should clean up async operations on unmount', async () => {
      let resolveSignIn: (value?: any) => void;
      (signIn as Mock).mockImplementation(() => new Promise(resolve => {
        resolveSignIn = resolve;
      }));
      
      const { unmount } = render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      fireEvent.click(signUpButton);
      
      // Unmount before operation completes
      unmount();
      
      // Complete the operation - should not cause errors
      resolveSignIn!();
      
      // No assertions needed - test passes if no errors thrown
    });

    it('should handle multiple concurrent authentication attempts', async () => {
      let resolveCount = 0;
      (signIn as Mock).mockImplementation(() => 
        new Promise(resolve => {
          setTimeout(() => {
            resolveCount++;
            resolve(undefined);
          }, 50);
        })
      );
      
      render(<SignUp />);
      
      const signUpButton = screen.getByText('Sign Up with Google');
      
      // Click multiple times rapidly
      fireEvent.click(signUpButton);
      fireEvent.click(signUpButton);
      fireEvent.click(signUpButton);
      
      // Should only process one request
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(signUpButton).toBeDisabled();
      
      await waitFor(() => {
        expect(resolveCount).toBe(1);
      });
    });
  });

  describe('Accessibility Integration', () => {
    it('should maintain focus flow through sign-up process', () => {
      render(<SignUp />);
      
      const signUpButton = screen.getByRole('button', { name: /Sign Up with Google/ });
      const signInLink = screen.getByRole('link', { name: /Already have an account/ });
      
      // Should be able to tab through elements
      signUpButton.focus();
      expect(document.activeElement).toBe(signUpButton);
      
      signInLink.focus();
      expect(document.activeElement).toBe(signInLink);
    });

    it('should provide proper headings hierarchy', () => {
      render(<SignUp />);
      
      const headings = screen.getAllByRole('heading', { level: 2 });
      const mainHeading = headings.find(h => h.textContent === 'Create your Semiont account');
      expect(mainHeading).toBeInTheDocument();
    });

    it('should handle keyboard navigation in Welcome page', async () => {
      const mockUserSession = {
        user: {
          name: 'Keyboard User',
          email: 'keyboard@example.com',
        },
        backendToken: 'keyboard-token',
        isNewUser: true,
      };
      
      (useSession as Mock).mockReturnValue({
        data: mockUserSession,
        status: 'authenticated',
      });
      
      renderWithProviders(<Welcome />);
      
      const acceptButton = screen.getByRole('button', { name: 'Accept & Continue' });
      const declineButton = screen.getByRole('button', { name: 'Decline & Sign Out' });
      
      // Should be able to focus on buttons
      acceptButton.focus();
      expect(document.activeElement).toBe(acceptButton);
      
      declineButton.focus();
      expect(document.activeElement).toBe(declineButton);
    });
  });

  describe('Browser Compatibility', () => {
    it('should handle missing localStorage gracefully', () => {
      // Mock localStorage to be undefined
      const originalLocalStorage = global.localStorage;
      // @ts-ignore
      delete global.localStorage;
      
      expect(() => render(<SignUp />)).not.toThrow();
      
      // Restore localStorage
      global.localStorage = originalLocalStorage;
    });

    it('should handle missing sessionStorage gracefully', () => {
      // Mock sessionStorage to be undefined  
      const originalSessionStorage = global.sessionStorage;
      // @ts-ignore
      delete global.sessionStorage;
      
      expect(() => render(<SignUp />)).not.toThrow();
      
      // Restore sessionStorage
      global.sessionStorage = originalSessionStorage;
    });

    it('should work without fetch API', async () => {
      const originalFetch = global.fetch;
      // @ts-ignore
      delete global.fetch;
      
      // Should still render components
      expect(() => render(<SignUp />)).not.toThrow();
      
      // Restore fetch
      global.fetch = originalFetch;
    });
  });
});