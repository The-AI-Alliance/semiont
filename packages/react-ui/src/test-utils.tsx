/**
 * Test utilities for @semiont/react-ui
 *
 * Provides a renderWithProviders helper that wraps components with all necessary providers
 * for testing, with customizable mock implementations.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { TranslationProvider } from './contexts/TranslationContext';
import { ApiClientProvider } from './contexts/ApiClientContext';
import { AuthTokenProvider } from './contexts/AuthTokenContext';
import {
  KnowledgeBaseSessionContext,
  type KnowledgeBaseSessionValue,
} from './contexts/KnowledgeBaseSessionContext';
import { OpenResourcesProvider } from './contexts/OpenResourcesContext';
import { EventBusProvider, useEventBus } from './contexts/EventBusContext';
import type { EventBus } from '@semiont/core';
import { ToastProvider } from './components/Toast';
import type { TranslationManager } from './types/TranslationManager';
import type { OpenResourcesManager } from './types/OpenResourcesManager';

/**
 * Default mock context value for KnowledgeBaseSessionProvider in tests.
 * Tests override individual fields via `createMockKnowledgeBaseSession`.
 */
export const defaultMockKnowledgeBaseSession: KnowledgeBaseSessionValue = {
  knowledgeBases: [],
  activeKnowledgeBase: null,
  session: null,
  isLoading: false,
  user: null,
  token: null,
  isAuthenticated: false,
  hasValidBackendToken: false,
  isFullyAuthenticated: false,
  displayName: 'User',
  avatarUrl: null,
  userDomain: undefined,
  isAdmin: false,
  isModerator: false,
  expiresAt: null,
  sessionExpiredAt: null,
  sessionExpiredMessage: null,
  permissionDeniedAt: null,
  permissionDeniedMessage: null,
  addKnowledgeBase: vi.fn(() => ({ id: 'mock', label: '', host: '', port: 0, protocol: 'http' as const, email: '' })),
  removeKnowledgeBase: vi.fn(),
  setActiveKnowledgeBase: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  refreshActive: vi.fn(async () => null),
  acknowledgeSessionExpired: vi.fn(),
  acknowledgePermissionDenied: vi.fn(),
};

/**
 * Construct a mock KnowledgeBaseSession context value with overrides.
 */
export function createMockKnowledgeBaseSession(
  overrides: Partial<KnowledgeBaseSessionValue> = {},
): KnowledgeBaseSessionValue {
  return { ...defaultMockKnowledgeBaseSession, ...overrides };
}

/**
 * Default mock implementations
 */
export const defaultMocks = {
  translationManager: {
    t: (namespace: string, key: string, params?: Record<string, any>) => {
      let result = `${namespace}.${key}`;
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          result = result.replace(`{${k}}`, String(v));
        });
      }
      return result;
    },
  } as TranslationManager,

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
  apiBaseUrl?: string;
  knowledgeBaseSession?: KnowledgeBaseSessionValue;
  openResourcesManager?: OpenResourcesManager;
}

export interface RenderWithProvidersOptions extends TestProvidersOptions, Omit<RenderOptions, 'wrapper'> {
  /** If true, returns the event bus instance along with render result */
  returnEventBus?: boolean;
}

export interface RenderWithProvidersResult extends RenderResult {
  eventBus?: EventBus;
}

/**
 * Wrapper component that captures the event bus instance
 */
function EventBusCapture({
  children,
  onEventBus
}: {
  children: React.ReactNode;
  onEventBus?: (bus: EventBus) => void
}) {
  const eventBus = useEventBus();
  React.useEffect(() => {
    onEventBus?.(eventBus);
  }, [eventBus, onEventBus]);
  return <>{children}</>;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderWithProvidersOptions
): RenderWithProvidersResult {
  const {
    translationManager = defaultMocks.translationManager,
    apiBaseUrl = 'http://localhost:4000',
    knowledgeBaseSession = defaultMockKnowledgeBaseSession,
    openResourcesManager = defaultMocks.openResourcesManager,
    returnEventBus = false,
    ...renderOptions
  } = options || {};

  let capturedEventBus: EventBus | undefined;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <EventBusProvider>
          <AuthTokenProvider token={null}>
            <ApiClientProvider baseUrl={apiBaseUrl}>
              <KnowledgeBaseSessionContext.Provider value={knowledgeBaseSession}>
                <OpenResourcesProvider openResourcesManager={openResourcesManager}>
                  <ToastProvider>
                    {returnEventBus ? (
                      <EventBusCapture onEventBus={(bus) => { capturedEventBus = bus; }}>
                        {children}
                      </EventBusCapture>
                    ) : (
                      children
                    )}
                  </ToastProvider>
                </OpenResourcesProvider>
              </KnowledgeBaseSessionContext.Provider>
            </ApiClientProvider>
          </AuthTokenProvider>
        </EventBusProvider>
      </TranslationProvider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...renderOptions });

  if (returnEventBus) {
    return { ...result, eventBus: capturedEventBus };
  }

  return result;
}

/**
 * Create a mock translation manager with custom translations
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
 * Create a mock open resources manager with custom resources
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
