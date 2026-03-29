/**
 * Frontend-specific test utilities
 *
 * Provides renderWithProviders that wraps components with ALL necessary providers
 * for testing, including react-ui providers and the JWT auth context.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  SessionManager,
  OpenResourcesManager,
} from '@semiont/react-ui';

export interface FrontendTestOptions extends Omit<TestProvidersOptions, 'queryClient'> {
  /**
   * Optional QueryClient instance for testing
   */
  queryClient?: QueryClient;
}

/**
 * Render component with all providers
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: FrontendTestOptions & Omit<RenderOptions, 'wrapper'>
): RenderResult {
  const {
    translationManager = defaultMocks.translationManager,
    apiBaseUrl = 'http://localhost:4000',
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
        <ApiClientProvider baseUrl={apiBaseUrl}>
          <ReactUiSessionProvider sessionManager={sessionManager}>
            <OpenResourcesProvider openResourcesManager={openResourcesManager}>
              <QueryClientProvider client={testQueryClient}>
                <ToastProvider>
                  {children}
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
  SessionManager,
  OpenResourcesManager,
};
