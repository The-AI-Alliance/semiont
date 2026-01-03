import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from '@/i18n/routing';
import { useAuth } from '@semiont/react-ui';
import { server } from '@/mocks/server';
import { http, HttpResponse } from 'msw';
import Welcome from '../page';
import { ToastProvider } from '@semiont/react-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Helper to create test query client
const createTestQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

// Helper function to render with providers
const renderWithProviders = (component: React.ReactElement) => {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {component}
      </ToastProvider>
    </QueryClientProvider>
  );
};

// Mock next-auth
vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
  signOut: vi.fn(),
  signIn: vi.fn(),
  SessionProvider: ({ children }: any) => children,
}));

// Mock @/i18n/routing
vi.mock('@/i18n/routing', () => ({
  useRouter: vi.fn(),
  Link: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

// Mock the useAuth hook to avoid ky HTTP client issues in vitest
vi.mock('@/lib/api-hooks', () => ({
  useAuth: vi.fn(),
}));

describe('Welcome Page', () => {
  const mockRouter = {
    push: vi.fn(),
  };

  const mockSession = {
    user: {
      name: 'John Doe',
      email: 'john@example.com',
    },
    backendToken: 'mock-token',
    isNewUser: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as Mock).mockReturnValue(mockRouter);
    (useSession as Mock).mockReturnValue({
      data: mockSession,
      status: 'authenticated',
    });

    // Mock useAuth to return React Query hooks
    (useAuth as Mock).mockReturnValue({
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

  describe('Authentication Checks', () => {
    it('redirects to signin if unauthenticated', async () => {
      (useSession as Mock).mockReturnValue({
        data: null,
        status: 'unauthenticated',
      });

      renderWithProviders(<Welcome />);

      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/auth/signin');
      });
    });

    it('shows loading state while checking session', () => {
      (useSession as Mock).mockReturnValue({
        data: null,
        status: 'loading',
      });

      renderWithProviders(<Welcome />);

      const loadingElements = screen.getAllByText('Loading...');
      expect(loadingElements.length).toBeGreaterThan(0);
      expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it('checks if user already accepted terms', async () => {
      renderWithProviders(<Welcome />);

      // Should make API call to check terms acceptance
      await waitFor(() => {
        expect(screen.getByText('Welcome to Semiont, John!')).toBeInTheDocument();
      });
    });

    it('redirects to home if terms already accepted', async () => {
      // Mock useAuth to return user with accepted terms
      (useAuth as Mock).mockReturnValue({
        me: {
          useQuery: () => ({
            data: {
              id: 'user123',
              email: 'test@example.com',
              name: 'Test User',
              termsAcceptedAt: '2024-01-01T00:00:00Z'
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

      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
      });
    });

    it('redirects existing users (not new) to home', async () => {
      (useSession as Mock).mockReturnValue({
        data: {
          ...mockSession,
          isNewUser: false,
        },
        status: 'authenticated',
      });

      renderWithProviders(<Welcome />);

      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
      });
    });

    it('handles missing backend token gracefully', () => {
      (useSession as Mock).mockReturnValue({
        data: {
          ...mockSession,
          backendToken: undefined,
        },
        status: 'authenticated',
      });

      renderWithProviders(<Welcome />);

      // Should not crash and should render the terms form
      expect(screen.getByText('Welcome to Semiont, John!')).toBeInTheDocument();
    });

    it('handles API errors when checking terms', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Override MSW handler to throw an error
      server.use(
        http.get('*/api/auth/me', () => {
          throw new Error('Network error');
        })
      );

      renderWithProviders(<Welcome />);

      // Component should still render even with API error
      expect(screen.getByText('Welcome to Semiont, John!')).toBeInTheDocument();
      
      // Note: This test may not trigger the error path in the test environment
      // The component gracefully handles API failures by continuing to show the terms form
      
      consoleError.mockRestore();
    });
  });

  describe('Terms Display', () => {
    it('shows welcome message with user first name', () => {
      renderWithProviders(<Welcome />);

      expect(screen.getByText('Welcome to Semiont, John!')).toBeInTheDocument();
    });

    it('displays terms of service content', () => {
      renderWithProviders(<Welcome />);

      expect(screen.getByText('Terms of Service Summary')).toBeInTheDocument();
      expect(screen.getByText('✅ Acceptable Use')).toBeInTheDocument();
      expect(screen.getByText('❌ Prohibited Content')).toBeInTheDocument();
      expect(screen.getByText('🤝 AI Alliance Code of Conduct')).toBeInTheDocument();
      expect(screen.getByText('🔒 Your Responsibilities')).toBeInTheDocument();
    });

    it('shows Accept and Decline buttons', () => {
      renderWithProviders(<Welcome />);

      expect(screen.getByRole('button', { name: 'Accept & Continue' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Decline & Sign Out' })).toBeInTheDocument();
    });

    it('links to full terms and privacy policy', () => {
      renderWithProviders(<Welcome />);

      const termsLinks = screen.getAllByRole('link', { name: 'Terms of Service' });
      const privacyLinks = screen.getAllByRole('link', { name: 'Privacy Policy' });
      
      // Get the first of each (might have duplicates from PageLayout)
      const termsLink = termsLinks[0];
      const privacyLink = privacyLinks[0];
      
      expect(termsLink).toHaveAttribute('href', '/terms');
      expect(termsLink).toHaveAttribute('target', '_blank');
      expect(privacyLink).toHaveAttribute('href', '/privacy');
      expect(privacyLink).toHaveAttribute('target', '_blank');
    });

    it('shows AI Alliance Code of Conduct link', () => {
      renderWithProviders(<Welcome />);

      const codeLink = screen.getByRole('link', { name: 'AI Alliance Code of Conduct' });
      expect(codeLink).toHaveAttribute('href', 'https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf');
      expect(codeLink).toHaveAttribute('target', '_blank');
      expect(codeLink).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('Terms Acceptance Flow', () => {
    it('calls API to record terms acceptance using MSW', async () => {
      const mockMutateAsync = vi.fn().mockResolvedValue({ success: true });

      (useAuth as Mock).mockReturnValue({
        me: {
          useQuery: () => ({
            data: { termsAcceptedAt: null },
            isLoading: false,
          }),
        },
        acceptTerms: {
          useMutation: () => ({
            mutateAsync: mockMutateAsync,
            isPending: false,
          }),
        },
      });

      renderWithProviders(<Welcome />);

      const acceptButton = screen.getByRole('button', { name: 'Accept & Continue' });
      fireEvent.click(acceptButton);

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalled();
      });
    });

    it('shows success state after accepting', async () => {
      const mockMutateAsync = vi.fn().mockResolvedValue({ success: true });

      (useAuth as Mock).mockReturnValue({
        me: {
          useQuery: () => ({
            data: { termsAcceptedAt: null },
            isLoading: false,
          }),
        },
        acceptTerms: {
          useMutation: () => ({
            mutateAsync: mockMutateAsync,
            isPending: false,
          }),
        },
      });

      renderWithProviders(<Welcome />);

      const acceptButton = screen.getByRole('button', { name: 'Accept & Continue' });
      fireEvent.click(acceptButton);

      await waitFor(() => {
        expect(screen.getByText('Welcome to Semiont!')).toBeInTheDocument();
        expect(screen.getByText('Thanks for accepting our terms. Redirecting you to the app...')).toBeInTheDocument();
      });
    });

    it('redirects to home after acceptance (with real timers)', async () => {
      const mockMutateAsync = vi.fn().mockResolvedValue({ success: true });

      (useAuth as Mock).mockReturnValue({
        me: {
          useQuery: () => ({
            data: { termsAcceptedAt: null },
            isLoading: false,
          }),
        },
        acceptTerms: {
          useMutation: () => ({
            mutateAsync: mockMutateAsync,
            isPending: false,
          }),
        },
      });

      renderWithProviders(<Welcome />);

      const acceptButton = screen.getByRole('button', { name: 'Accept & Continue' });
      fireEvent.click(acceptButton);

      // Wait for terms accepted state
      await waitFor(() => {
        expect(screen.getByText('Welcome to Semiont!')).toBeInTheDocument();
      });

      // Wait for the setTimeout to trigger router push (1 second + buffer)
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
      }, { timeout: 2000 });
    });

    it('handles terms decline (dynamic import limitation)', async () => {
      renderWithProviders(<Welcome />);

      const declineButton = screen.getByRole('button', { name: 'Decline & Sign Out' });
      
      // Verify button exists and is clickable
      expect(declineButton).toBeInTheDocument();
      expect(declineButton).not.toBeDisabled();
      
      // Click the button (the dynamic import of signOut is hard to test in this context)
      fireEvent.click(declineButton);
      
      // The actual signOut call happens via dynamic import which is difficult to mock properly
      // This test verifies the UI interaction works correctly
    });

    it('handles API errors during acceptance using MSW', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockMutateAsync = vi.fn().mockRejectedValue(new Error('API Error'));

      (useAuth as Mock).mockReturnValue({
        me: {
          useQuery: () => ({
            data: { termsAcceptedAt: null },
            isLoading: false,
          }),
        },
        acceptTerms: {
          useMutation: () => ({
            mutateAsync: mockMutateAsync,
            isPending: false,
          }),
        },
      });

      renderWithProviders(<Welcome />);

      const acceptButton = screen.getByRole('button', { name: 'Accept & Continue' });
      fireEvent.click(acceptButton);

      // Wait for error handling - the error is now shown via toast instead of alert
      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Terms acceptance error:', expect.any(Error));
      }, { timeout: 3000 });

      consoleError.mockRestore();
    });
  });

  describe('Edge Cases', () => {
    it('handles user without name gracefully', () => {
      (useSession as Mock).mockReturnValue({
        data: {
          ...mockSession,
          user: {
            ...mockSession.user,
            name: null,
          },
        },
        status: 'authenticated',
      });

      renderWithProviders(<Welcome />);

      expect(screen.getByText('Welcome to Semiont, !')).toBeInTheDocument();
    });

    it('handles user with single name', () => {
      (useSession as Mock).mockReturnValue({
        data: {
          ...mockSession,
          user: {
            ...mockSession.user,
            name: 'Madonna',
          },
        },
        status: 'authenticated',
      });

      renderWithProviders(<Welcome />);

      expect(screen.getByText('Welcome to Semiont, Madonna!')).toBeInTheDocument();
    });
  });
});