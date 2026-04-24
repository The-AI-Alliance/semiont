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
import { baseUrl, EventBus } from '@semiont/core';
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
    expiresAt: null,
    refresh: vi.fn(async () => null),
  };
  // Modal-state mock sits on its own BehaviorSubject so tests that
  // exercise the session-expired / permission-denied paths can poke
  // it directly. Mirrors the `FrontendSessionSignals` shape.
  const fakeSignals = {
    sessionExpiredAt$: new BehaviorSubject<number | null>(null),
    sessionExpiredMessage$: new BehaviorSubject<string | null>(null),
    permissionDeniedAt$: new BehaviorSubject<number | null>(null),
    permissionDeniedMessage$: new BehaviorSubject<string | null>(null),
    notifySessionExpired: vi.fn(),
    notifyPermissionDenied: vi.fn(),
    acknowledgeSessionExpired: vi.fn(),
    acknowledgePermissionDenied: vi.fn(),
    dispose: vi.fn(),
  };
  const activeSession$ = new BehaviorSubject<any>(fakeSession);
  const activeSignals$ = new BehaviorSubject<any>(fakeSignals);
  const sessionActivating$ = new BehaviorSubject<boolean>(false);
  const identityToken$ = new BehaviorSubject<null>(null);
  const openResources$ = new BehaviorSubject<any[]>([]);
  const kbs$ = new BehaviorSubject<any[]>([]);
  const activeKbId$ = new BehaviorSubject<string | null>(null);
  const error$ = new BehaviorSubject<never>(null as never);
  // App-scoped bus: a real EventBus stand-in so tests exercising
  // `semiont.emit/on/stream` round-trip through a live subject.
  const shellBus = new EventBus();
  return {
    activeSession$,
    activeSignals$,
    sessionActivating$,
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
    emit: (channel: any, payload: any) => shellBus.get(channel).next(payload),
    on: (channel: any, handler: any) => {
      const sub = shellBus.get(channel).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: (channel: any) => shellBus.get(channel).asObservable(),
    _shellBus: shellBus,
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
  /**
   * If true, returns the session (client) EventBus — session-scoped
   * channels (mark:*, beckon:*, gather:*, match:*, bind:*, yield:*,
   * browse:click, browse:reference-navigate, browse:entity-type-clicked).
   */
  returnEventBus?: boolean;
  /**
   * If true, returns the app-scoped (SemiontBrowser) EventBus — panel:*,
   * shell:*, tabs:*, nav:*, settings:*.
   */
  returnShellBus?: boolean;
}

export interface RenderWithProvidersResult extends RenderResult {
  /** Session-scoped bus (from the fake client inside the fake browser). */
  eventBus?: EventBus;
  /** App-scoped bus (the fake browser's own bus). */
  shellBus?: EventBus;
}

/** Read the app-scoped bus stashed on the fake browser by createFakeBrowserForTests. */
function shellBusOf(browser: SemiontBrowser): EventBus | undefined {
  return (browser as unknown as { _shellBus?: EventBus })._shellBus;
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
    returnShellBus = false,
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

  const extras: Partial<RenderWithProvidersResult> = {};
  if (returnEventBus && client) extras.eventBus = busOf(client);
  if (returnShellBus) extras.shellBus = shellBusOf(fakeBrowser);
  return Object.keys(extras).length ? { ...result, ...extras } : result;
}

/**
 * Build a minimal `<SemiontProvider>` wrapper for tests that roll their
 * own render wrapper (instead of `renderWithProviders`). The returned
 * `eventBus` is the bus backing the fake session's client — same
 * reference production code pokes via `session.client.emit(...)`.
 */
export function createTestSemiontWrapper(apiBaseUrl: string = 'http://localhost:4000'): {
  SemiontWrapper: React.ComponentType<{ children: React.ReactNode }>;
  /** Session-scoped bus (from the fake client). */
  eventBus: EventBus;
  /** App-scoped bus (the fake browser's own bus). */
  shellBus: EventBus;
  /** The fake session's client — for tests that need to spy on namespace methods. */
  client: SemiontApiClient;
} {
  const fakeBrowser = createFakeBrowserForTests(apiBaseUrl);
  const fakeSession = (fakeBrowser as unknown as { activeSession$: { getValue(): { client: SemiontApiClient } | null } }).activeSession$.getValue();
  const client = fakeSession!.client;
  const SemiontWrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontProvider browser={fakeBrowser}>{children}</SemiontProvider>
  );
  return {
    SemiontWrapper,
    eventBus: busOf(client),
    shellBus: shellBusOf(fakeBrowser)!,
    client,
  };
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
 * Build a fake SemiontBrowser with the active FrontendSessionSignals
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
    expiresAt: null,
    refresh: vi.fn(async () => null),
  };
  const signals = {
    permissionDeniedAt$: new BehaviorSubject<number | null>(overrides.permissionDeniedAt ?? null),
    permissionDeniedMessage$: new BehaviorSubject<string | null>(overrides.permissionDeniedMessage ?? null),
    sessionExpiredAt$: new BehaviorSubject<number | null>(overrides.sessionExpiredAt ?? null),
    sessionExpiredMessage$: new BehaviorSubject<string | null>(overrides.sessionExpiredMessage ?? null),
    notifyPermissionDenied: vi.fn(),
    notifySessionExpired: vi.fn(),
    acknowledgePermissionDenied: overrides.acknowledgePermissionDenied ?? vi.fn(),
    acknowledgeSessionExpired: overrides.acknowledgeSessionExpired ?? vi.fn(),
    dispose: vi.fn(),
  };
  return {
    activeSession$: new BehaviorSubject(session),
    activeSignals$: new BehaviorSubject(signals),
    sessionActivating$: new BehaviorSubject<boolean>(false),
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
    // App-scoped bus stubs (post-shell-vm refactor). Minimal so
    // useEventSubscription(s) can register without exploding.
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => ({ subscribe: () => ({ unsubscribe: () => {} }) })),
  } as unknown as SemiontBrowser;
}

// Re-export testing library utilities
export * from '@testing-library/react';
export { vi } from 'vitest';
