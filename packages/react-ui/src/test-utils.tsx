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
import { SemiontApiClient, type SemiontBrowser } from '@semiont/api-client';
import { baseUrl, type EventBus } from '@semiont/core';
import { TranslationProvider } from './contexts/TranslationContext';
import { ToastProvider } from './components/Toast';
import type { TranslationManager } from './types/TranslationManager';
import { SemiontProvider } from './session/SemiontProvider';

/**
 * Minimal fake SemiontBrowser for tests. Emits a fake session whose `client`
 * is a fresh SemiontApiClient constructed off `apiBaseUrl`. Tests that spy
 * on client methods (e.g. `BindNamespace.prototype.body`) rely on the
 * real-ish client surface. Tests that inspect events production code emits
 * subscribe via `client.on(channel, handler)`.
 */
function createFakeBrowserForTests(
  apiBaseUrl: string,
): SemiontBrowser {
  const client = new SemiontApiClient({
    baseUrl: baseUrl(apiBaseUrl),
  });
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
};

/**
 * Options for renderWithProviders
 */
export interface TestProvidersOptions {
  translationManager?: TranslationManager;
  apiBaseUrl?: string;
  /** Inject a specific SemiontBrowser (e.g. one seeded with a kbs list). */
  browser?: SemiontBrowser;
}

/**
 * Extract the internal bus from a client for test assertions. Production
 * code uses `client.emit` / `client.on` / `client.stream`; tests still
 * reach for raw subjects because many pre-existing test suites do
 * `bus.get(channel).subscribe(...)` / `.next(...)`. That migration is
 * tracked as a follow-up; in the meantime, this cast is the single
 * sanctioned escape hatch.
 */
function busOf(client: SemiontApiClient): EventBus {
  return (client as unknown as { eventBus: EventBus }).eventBus;
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
    browser,
    returnEventBus = false,
    ...renderOptions
  } = options || {};

  const fakeBrowser = browser ?? createFakeBrowserForTests(apiBaseUrl);
  const fakeSession = (fakeBrowser as unknown as { activeSession$: { getValue(): { client?: SemiontApiClient } | null } }).activeSession$.getValue();
  const client = fakeSession?.client;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <SemiontProvider browser={fakeBrowser}>
          <ToastProvider>
            {children}
          </ToastProvider>
        </SemiontProvider>
      </TranslationProvider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...renderOptions });

  if (returnEventBus && client) {
    return { ...result, eventBus: busOf(client) };
  }

  return result;
}

/**
 * Build a minimal `<SemiontProvider>` wrapper for tests that roll their
 * own render wrapper (instead of `renderWithProviders`). The returned
 * `eventBus` is the bus backing the fake session's client — same
 * reference production code pokes via `session.client.emit(...)`.
 */
export function createTestSemiontWrapper(apiBaseUrl: string = 'http://localhost:4000'): {
  SemiontWrapper: React.ComponentType<{ children: React.ReactNode }>;
  eventBus: EventBus;
} {
  const fakeBrowser = createFakeBrowserForTests(apiBaseUrl);
  const fakeSession = (fakeBrowser as unknown as { activeSession$: { getValue(): { client: SemiontApiClient } | null } }).activeSession$.getValue();
  const client = fakeSession!.client;
  const SemiontWrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontProvider browser={fakeBrowser}>{children}</SemiontProvider>
  );
  return { SemiontWrapper, eventBus: busOf(client) };
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

// Re-export testing library utilities
export * from '@testing-library/react';
export { vi } from 'vitest';
