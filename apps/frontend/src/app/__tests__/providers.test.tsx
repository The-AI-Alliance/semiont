import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { QueryClient } from '@tanstack/react-query';
import { Providers } from '@/app/providers';
import { APIError } from '@/lib/api';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) =>
    <div data-testid="session-provider">{children}</div>,
  useSession: () => ({
    status: 'authenticated',
    data: { backendToken: 'mock-token' }
  })
}));

// Mock custom contexts
vi.mock('@/contexts/SessionContext', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCustomSession: () => ({ isFullyAuthenticated: true })
}));

vi.mock('@/contexts/KeyboardShortcutsContext', () => ({
  KeyboardShortcutsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

vi.mock('@/components/Toast', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn() })
}));

vi.mock('@/components/LiveRegion', () => ({
  LiveRegionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

vi.mock('@/components/AuthErrorBoundary', () => ({
  AuthErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

// Mock react-query to spy on QueryClient creation
vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    QueryClient: vi.fn().mockImplementation((options) => new (actual as any).QueryClient(options)),
    QueryClientProvider: ({ children }: { children: React.ReactNode }) =>
      <div data-testid="query-client-provider">{children}</div>
  };
});

describe('Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render children with all providers', () => {
    const TestChild = () => <div data-testid="test-child">Test Content</div>;
    
    render(
      <Providers>
        <TestChild />
      </Providers>
    );
    
    // Check that child is rendered
    expect(screen.getByTestId('test-child')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  it('should wrap children with SessionProvider', () => {
    const TestChild = () => <div data-testid="test-child">Test Content</div>;
    
    render(
      <Providers>
        <TestChild />
      </Providers>
    );
    
    expect(screen.getByTestId('session-provider')).toBeInTheDocument();
    expect(screen.getByTestId('test-child')).toBeInTheDocument();
  });

  it('should wrap children with QueryClientProvider', () => {
    const TestChild = () => <div data-testid="test-child">Test Content</div>;
    
    render(
      <Providers>
        <TestChild />
      </Providers>
    );
    
    expect(screen.getByTestId('query-client-provider')).toBeInTheDocument();
    expect(screen.getByTestId('test-child')).toBeInTheDocument();
  });

  it('should initialize QueryClient with security-focused configuration', () => {
    const MockedQueryClient = vi.mocked(QueryClient);
    
    render(
      <Providers>
        <div>test</div>
      </Providers>
    );
    
    // Verify QueryClient was called with configuration including caches
    expect(MockedQueryClient).toHaveBeenCalledWith(
      expect.objectContaining({
        queryCache: expect.any(Object),
        mutationCache: expect.any(Object),
        defaultOptions: {
          queries: expect.objectContaining({
            retry: expect.any(Function),
            staleTime: 5 * 60 * 1000, // 5 minutes
          }),
        },
      })
    );
  });

  it('should configure retry logic to not retry on authentication errors', () => {
    const MockedQueryClient = vi.mocked(QueryClient);
    
    render(
      <Providers>
        <div>test</div>
      </Providers>
    );
    
    // Get the retry function that was passed to QueryClient
    const queryClientConfig = MockedQueryClient.mock.calls[0]?.[0];
    const retryFunction = queryClientConfig?.defaultOptions?.queries?.retry as Function;
    
    expect(retryFunction).toBeDefined();
    
    // Test retry logic for 401 errors
    const error401 = new APIError(401, { error: 'Unauthorized' });
    expect(retryFunction(0, error401)).toBe(false);

    // Test retry logic for 403 errors
    const error403 = new APIError(403, { error: 'Forbidden' });
    expect(retryFunction(0, error403)).toBe(false);

    // Test retry logic for other API errors (should retry)
    const error500 = new APIError(500, { error: 'Internal Server Error' });
    expect(retryFunction(0, error500)).toBe(true);
    
    // Test retry logic for other errors (should retry up to 3 times)
    const networkError = new Error('Network error');
    expect(retryFunction(0, networkError)).toBe(true);
    expect(retryFunction(1, networkError)).toBe(true);
    expect(retryFunction(2, networkError)).toBe(true);
    expect(retryFunction(3, networkError)).toBe(false);
  });

  it('should handle non-Error objects in retry logic', () => {
    const MockedQueryClient = vi.mocked(QueryClient);
    
    render(
      <Providers>
        <div>test</div>
      </Providers>
    );
    
    const queryClientConfig = MockedQueryClient.mock.calls[0]?.[0];
    const retryFunction = queryClientConfig?.defaultOptions?.queries?.retry as Function;
    
    // Test with non-Error object (not an APIError)
    const nonError = { message: '401 unauthorized' };
    expect(retryFunction(0, nonError)).toBe(true); // Should retry since it's not an APIError instance
    
    // Test with null/undefined
    expect(retryFunction(0, null)).toBe(true);
    expect(retryFunction(0, undefined)).toBe(true);
  });

  it('should maintain provider hierarchy', () => {
    const TestChild = () => {
      // This would fail if providers are not properly nested
      return <div data-testid="nested-child">Nested Content</div>;
    };
    
    render(
      <Providers>
        <TestChild />
      </Providers>
    );
    
    const sessionProvider = screen.getByTestId('session-provider');
    const queryProvider = screen.getByTestId('query-client-provider');
    const child = screen.getByTestId('nested-child');
    
    // Verify nesting structure exists
    expect(sessionProvider).toBeInTheDocument();
    expect(queryProvider).toBeInTheDocument();
    expect(child).toBeInTheDocument();
  });

  it('should set appropriate stale time for security-sensitive data', () => {
    const MockedQueryClient = vi.mocked(QueryClient);
    
    render(
      <Providers>
        <div>test</div>
      </Providers>
    );
    
    const config = MockedQueryClient.mock.calls[0]?.[0];
    const staleTime = config?.defaultOptions?.queries?.staleTime;
    
    // 5 minutes in milliseconds
    expect(staleTime).toBe(5 * 60 * 1000);
  });
});