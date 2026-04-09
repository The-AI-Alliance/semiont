/**
 * Frontend-specific test utilities
 *
 * Provides renderWithProviders that wraps components with the providers a
 * frontend test typically needs. The KnowledgeBaseSession context is mocked
 * via the library context provider so tests can supply a fake session value
 * without going through localStorage / JWT validation.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TranslationProvider,
  ApiClientProvider,
  OpenResourcesProvider,
  ToastProvider,
  KnowledgeBaseSessionContext,
} from '@semiont/react-ui';
import {
  defaultMocks,
  defaultMockKnowledgeBaseSession,
  createMockKnowledgeBaseSession,
  TestProvidersOptions,
  createMockTranslationManager,
  createMockOpenResourcesManager,
} from '@semiont/react-ui/test-utils';
import type {
  TranslationManager,
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
    knowledgeBaseSession = defaultMockKnowledgeBaseSession,
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
          <KnowledgeBaseSessionContext.Provider value={knowledgeBaseSession}>
            <OpenResourcesProvider openResourcesManager={openResourcesManager}>
              <QueryClientProvider client={testQueryClient}>
                <ToastProvider>
                  {children}
                </ToastProvider>
              </QueryClientProvider>
            </OpenResourcesProvider>
          </KnowledgeBaseSessionContext.Provider>
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
  defaultMockKnowledgeBaseSession,
  createMockKnowledgeBaseSession,
  createMockTranslationManager,
  createMockOpenResourcesManager,
};
export type {
  TestProvidersOptions,
  TranslationManager,
  OpenResourcesManager,
};
