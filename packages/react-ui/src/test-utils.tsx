/**
 * Test utilities for @semiont/react-ui
 *
 * Provides a renderWithProviders helper that wraps components with all necessary providers
 * for testing, with customizable mock implementations.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { SemiontApiClient } from '@semiont/api-client';
import { EventBus, baseUrl } from '@semiont/core';
import { TranslationProvider } from './contexts/TranslationContext';
import { ApiClientProvider } from './contexts/ApiClientContext';
import { OpenResourcesProvider } from './contexts/OpenResourcesContext';
import { ToastProvider } from './components/Toast';
import type { TranslationManager } from './types/TranslationManager';
import type { OpenResourcesManager } from './types/OpenResourcesManager';
import type { SemiontBrowser } from './session/semiont-browser';
import { SemiontProvider } from './session/SemiontProvider';

/**
 * Minimal fake SemiontBrowser for tests. Emits a fake session whose `client`
 * is a fresh SemiontApiClient constructed off `apiBaseUrl` — matching the
 * behavior the old `<ApiClientProvider>` wrapper provided. Tests that spy on
 * client methods (e.g. `BindNamespace.prototype.body`) can therefore rely on
 * the real-ish client surface.
 */
function createFakeBrowserForTests(
  apiBaseUrl: string,
  eventBus: EventBus,
): SemiontBrowser {
  const client = new SemiontApiClient({
    baseUrl: baseUrl(apiBaseUrl),
    eventBus,
  });
  // Minimal session stub exposing the emit/on facade expected by
  // production code. Uses the same EventBus the client was constructed with,
  // so tests that inspect the bus see the events production code emits.
  const fakeSession = {
    client,
    kb: null,
    user$: new BehaviorSubject<any>(null),
    token$: new BehaviorSubject<any>(null),
    sessionExpiredAt$: new BehaviorSubject<number | null>(null),
    sessionExpiredMessage$: new BehaviorSubject<string | null>(null),
    permissionDeniedAt$: new BehaviorSubject<number | null>(null),
    permissionDeniedMessage$: new BehaviorSubject<string | null>(null),
    expiresAt: null,
    refresh: vi.fn(async () => null),
    acknowledgeSessionExpired: vi.fn(),
    acknowledgePermissionDenied: vi.fn(),
    emit<K extends string>(channel: K, payload: unknown): void {
      (eventBus.get(channel as any) as unknown as { next(v: unknown): void }).next(payload);
    },
    on<K extends string>(channel: K, handler: (payload: unknown) => void): () => void {
      const sub = (eventBus.get(channel as any) as unknown as { subscribe(h: (v: unknown) => void): { unsubscribe(): void } }).subscribe(handler);
      return () => sub.unsubscribe();
    },
  };
  const activeSession$ = new BehaviorSubject<any>(fakeSession);
  const identityToken$ = new BehaviorSubject<null>(null);
  const openResources$ = new BehaviorSubject<any[]>([]);
  const kbs$ = new BehaviorSubject<any[]>([]);
  const activeKbId$ = new BehaviorSubject<string | null>(null);
  const error$ = new BehaviorSubject<never>(null as never);
  return {
    activeSession$,
    identityToken$,
    openResources$,
    kbs$,
    activeKbId$,
    error$,
    addKb: vi.fn(),
    removeKb: vi.fn(),
    updateKb: vi.fn(),
    setActiveKb: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    setIdentityToken: vi.fn(),
    addOpenResource: vi.fn(),
    removeOpenResource: vi.fn(),
    updateOpenResourceName: vi.fn(),
    reorderOpenResources: vi.fn(),
    dispose: vi.fn(async () => {}),
  } as unknown as SemiontBrowser;
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
  openResourcesManager?: OpenResourcesManager;
  /** Inject a specific SemiontBrowser (e.g. one seeded with a kbs list). */
  browser?: SemiontBrowser;
}

export interface RenderWithProvidersOptions extends TestProvidersOptions, Omit<RenderOptions, 'wrapper'> {
  /** If true, returns the event bus instance along with render result */
  returnEventBus?: boolean;
}

export interface RenderWithProvidersResult extends RenderResult {
  eventBus?: EventBus;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderWithProvidersOptions
): RenderWithProvidersResult {
  const {
    translationManager = defaultMocks.translationManager,
    apiBaseUrl = 'http://localhost:4000',
    openResourcesManager = defaultMocks.openResourcesManager,
    browser,
    returnEventBus = false,
    ...renderOptions
  } = options || {};

  // Single bus shared by the SemiontApiClient and the fake session's emit/on —
  // so tests that subscribe via the returned `eventBus` see everything
  // production code emits via `session?.emit(...)`.
  const sharedBus = new EventBus();
  const fakeBrowser = browser ?? createFakeBrowserForTests(apiBaseUrl, sharedBus);

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <SemiontProvider browser={fakeBrowser}>
          <ApiClientProvider baseUrl={apiBaseUrl}>
            <OpenResourcesProvider openResourcesManager={openResourcesManager}>
              <ToastProvider>
                {children}
              </ToastProvider>
            </OpenResourcesProvider>
          </ApiClientProvider>
        </SemiontProvider>
      </TranslationProvider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...renderOptions });

  if (returnEventBus) {
    return { ...result, eventBus: sharedBus };
  }

  return result;
}

/**
 * Build a minimal `<SemiontProvider>` wrapper over a shared EventBus for
 * tests that roll their own render wrapper (instead of `renderWithProviders`).
 * Tests subscribe to `eventBus` to assert events that production code emits
 * via `session?.emit(...)`.
 */
export function createTestSemiontWrapper(apiBaseUrl: string = 'http://localhost:4000'): {
  SemiontWrapper: React.ComponentType<{ children: React.ReactNode }>;
  eventBus: EventBus;
} {
  const eventBus = new EventBus();
  const fakeBrowser = createFakeBrowserForTests(apiBaseUrl, eventBus);
  const SemiontWrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontProvider browser={fakeBrowser}>{children}</SemiontProvider>
  );
  return { SemiontWrapper, eventBus };
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
 * Build a fake SemiontBrowser with the active session's modal-state
 * observables pre-populated. Used by SessionExpiredModal and
 * PermissionDeniedModal tests that need to control the modal flags
 * without driving a real session through its state machine.
 */
export function createMockKnowledgeBaseSession(overrides: {
  permissionDeniedAt?: number | null;
  permissionDeniedMessage?: string | null;
  sessionExpiredAt?: number | null;
  sessionExpiredMessage?: string | null;
  acknowledgePermissionDenied?: () => void;
  acknowledgeSessionExpired?: () => void;
} = {}): SemiontBrowser {
  const session = {
    kb: null,
    user$: new BehaviorSubject<unknown>(null),
    token$: new BehaviorSubject<unknown>(null),
    permissionDeniedAt$: new BehaviorSubject<number | null>(overrides.permissionDeniedAt ?? null),
    permissionDeniedMessage$: new BehaviorSubject<string | null>(overrides.permissionDeniedMessage ?? null),
    sessionExpiredAt$: new BehaviorSubject<number | null>(overrides.sessionExpiredAt ?? null),
    sessionExpiredMessage$: new BehaviorSubject<string | null>(overrides.sessionExpiredMessage ?? null),
    acknowledgePermissionDenied: overrides.acknowledgePermissionDenied ?? vi.fn(),
    acknowledgeSessionExpired: overrides.acknowledgeSessionExpired ?? vi.fn(),
    expiresAt: null,
    refresh: vi.fn(async () => null),
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  };
  return {
    activeSession$: new BehaviorSubject(session),
    kbs$: new BehaviorSubject<unknown[]>([]),
    activeKbId$: new BehaviorSubject<string | null>(null),
    openResources$: new BehaviorSubject<unknown[]>([]),
    identityToken$: new BehaviorSubject<string | null>(null),
    error$: new BehaviorSubject<unknown>(null),
    addKb: vi.fn(),
    removeKb: vi.fn(),
    updateKb: vi.fn(),
    setActiveKb: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    setIdentityToken: vi.fn(),
    addOpenResource: vi.fn(),
    removeOpenResource: vi.fn(),
    updateOpenResourceName: vi.fn(),
    reorderOpenResources: vi.fn(),
    dispose: vi.fn(async () => {}),
  } as unknown as SemiontBrowser;
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
