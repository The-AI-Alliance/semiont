/**
 * Test utilities for @semiont/react-ui
 *
 * Provides a renderWithProviders helper that wraps components with all necessary providers
 * for testing, with customizable mock implementations.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TranslationProvider } from './contexts/TranslationContext';
import { ApiClientProvider } from './contexts/ApiClientContext';
import { SessionProvider } from './contexts/SessionContext';
import { OpenResourcesProvider } from './contexts/OpenResourcesContext';
import type { TranslationManager } from './types/TranslationManager';
import type { ApiClientManager } from './types/ApiClientManager';
import type { SessionManager } from './types/SessionManager';
import type { OpenResourcesManager } from './types/OpenResourcesManager';

/**
 * Default mock implementations
 */
export const defaultMocks = {
  translationManager: {
    t: (namespace: string, key: string) => `${namespace}.${key}`,
  } as TranslationManager,

  apiClientManager: {
    client: null,
  } as ApiClientManager,

  sessionManager: {
    isAuthenticated: false,
    expiresAt: null,
    timeUntilExpiry: null,
    isExpiringSoon: false,
  } as SessionManager,

  openResourcesManager: {
    openResources: [],
    addResource: vi.fn(),
    removeResource: vi.fn(),
    updateResourceName: vi.fn(),
    reorderResources: vi.fn(),
  } as OpenResourcesManager,
};

/**
 * Options for renderWithProviders
 */
export interface TestProvidersOptions {
  translationManager?: TranslationManager;
  apiClientManager?: ApiClientManager;
  sessionManager?: SessionManager;
  openResourcesManager?: OpenResourcesManager;
  queryClient?: QueryClient;
}

/**
 * Render component with all providers
 *
 * @example
 * ```tsx
 * import { renderWithProviders } from '@semiont/react-ui/test-utils';
 *
 * it('should render component', () => {
 *   renderWithProviders(<MyComponent />);
 *   expect(screen.getByText('Hello')).toBeInTheDocument();
 * });
 *
 * it('should work with authenticated client', () => {
 *   const mockClient = new SemiontApiClient({ ... });
 *   renderWithProviders(<MyComponent />, {
 *     apiClientManager: { client: mockClient },
 *   });
 * });
 * ```
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: TestProvidersOptions & Omit<RenderOptions, 'wrapper'>
): RenderResult {
  const {
    translationManager = defaultMocks.translationManager,
    apiClientManager = defaultMocks.apiClientManager,
    sessionManager = defaultMocks.sessionManager,
    openResourcesManager = defaultMocks.openResourcesManager,
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    }),
    ...renderOptions
  } = options || {};

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <ApiClientProvider apiClientManager={apiClientManager}>
          <SessionProvider sessionManager={sessionManager}>
            <OpenResourcesProvider openResourcesManager={openResourcesManager}>
              <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
            </OpenResourcesProvider>
          </SessionProvider>
        </ApiClientProvider>
      </TranslationProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

/**
 * Create a mock translation manager with custom translations
 *
 * @example
 * ```tsx
 * const translations = createMockTranslationManager({
 *   Toolbar: { save: 'Save', cancel: 'Cancel' },
 *   Footer: { copyright: '© 2024' },
 * });
 *
 * renderWithProviders(<MyComponent />, {
 *   translationManager: translations,
 * });
 * ```
 */
export function createMockTranslationManager(
  translations: Record<string, Record<string, string>>
): TranslationManager {
  return {
    t: (namespace: string, key: string) => {
      return translations[namespace]?.[key] || key;
    },
  };
}

/**
 * Create a mock session manager with custom session state
 *
 * @example
 * ```tsx
 * const session = createMockSessionManager({
 *   isAuthenticated: true,
 *   expiresAt: new Date(Date.now() + 3600000),
 * });
 *
 * renderWithProviders(<MyComponent />, {
 *   sessionManager: session,
 * });
 * ```
 */
export function createMockSessionManager(
  state: Partial<SessionManager>
): SessionManager {
  return {
    isAuthenticated: false,
    expiresAt: null,
    timeUntilExpiry: null,
    isExpiringSoon: false,
    ...state,
  };
}

/**
 * Create a mock open resources manager with custom resources
 *
 * @example
 * ```tsx
 * const resources = createMockOpenResourcesManager([
 *   { id: 'doc-1', name: 'Document 1', openedAt: Date.now() },
 * ]);
 *
 * renderWithProviders(<MyComponent />, {
 *   openResourcesManager: resources,
 * });
 * ```
 */
export function createMockOpenResourcesManager(
  resources: OpenResourcesManager['openResources'] = []
): OpenResourcesManager {
  return {
    openResources: resources,
    addResource: vi.fn(),
    removeResource: vi.fn(),
    updateResourceName: vi.fn(),
    reorderResources: vi.fn(),
  };
}

// Re-export testing library utilities
export * from '@testing-library/react';
export { vi } from 'vitest';
