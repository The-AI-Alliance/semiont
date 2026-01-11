/**
 * Frontend-specific test utilities
 *
 * Provides renderWithProviders that wraps components with ALL necessary providers
 * for testing, including both react-ui providers AND next-auth SessionProvider.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import {
  TranslationProvider,
  ApiClientProvider,
  SessionProvider as ReactUiSessionProvider,
  OpenResourcesProvider,
  ToastProvider,
} from '@semiont/react-ui';
import {
  defaultMocks,
  TestProvidersOptions,
  createMockTranslationManager,
  createMockSessionManager,
  createMockOpenResourcesManager,
} from '@semiont/react-ui/test-utils';
import type {
  TranslationManager,
  ApiClientManager,
  SessionManager,
  OpenResourcesManager,
} from '@semiont/react-ui';

export interface FrontendTestOptions extends Omit<TestProvidersOptions, 'queryClient'> {
  /**
   * Mock next-auth session data
   */
  nextAuthSession?: any;
  /**
   * Mock next-auth session status (loading, authenticated, unauthenticated)
   */
  sessionStatus?: 'loading' | 'authenticated' | 'unauthenticated';
  /**
   * Optional QueryClient instance for testing
   */
  queryClient?: QueryClient;
}

/**
 * Render component with all providers including next-auth SessionProvider
 *
 * @example
 * ```tsx
 * import { renderWithProviders } from '@/test-utils';
 *
 * it('should render authenticated component', () => {
 *   renderWithProviders(<MyComponent />, {
 *     nextAuthSession: {
 *       user: { name: 'Test User', email: 'test@example.com' },
 *       backendToken: 'mock-token',
 *     },
 *   });
 * });
 * ```
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: FrontendTestOptions & Omit<RenderOptions, 'wrapper'>
): RenderResult {
  const {
    nextAuthSession = null,
    translationManager = defaultMocks.translationManager,
    apiClientManager = defaultMocks.apiClientManager,
    sessionManager = defaultMocks.sessionManager,
    openResourcesManager = defaultMocks.openResourcesManager,
    queryClient: providedQueryClient,
    ...renderOptions
  } = options || {};

  const testQueryClient: QueryClient = providedQueryClient ?? new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <ApiClientProvider apiClientManager={apiClientManager}>
          <ReactUiSessionProvider sessionManager={sessionManager}>
            <OpenResourcesProvider openResourcesManager={openResourcesManager}>
              <QueryClientProvider client={testQueryClient}>
                <ToastProvider>
                  <SessionProvider session={nextAuthSession}>
                    {children}
                  </SessionProvider>
                </ToastProvider>
              </QueryClientProvider>
            </OpenResourcesProvider>
          </ReactUiSessionProvider>
        </ApiClientProvider>
      </TranslationProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

// Re-export everything from react-ui test-utils for convenience
export * from '@testing-library/react';
export { vi } from 'vitest';
export {
  defaultMocks,
  createMockTranslationManager,
  createMockSessionManager,
  createMockOpenResourcesManager,
};
export type {
  TestProvidersOptions,
  TranslationManager,
  ApiClientManager,
  SessionManager,
  OpenResourcesManager,
};
