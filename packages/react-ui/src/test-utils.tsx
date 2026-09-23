/**
 * Test utilities for @semiont/react-ui
 *
 * Provides a renderWithProviders helper that wraps components with all necessary providers
 * for testing, with customizable mock implementations.
 *
 * THE DOUBLES LIVE IN `@semiont/sdk/testing`, NOT HERE — `createTestClient` /
 * `createTestSession` (real client and session over `FaultyTransport`),
 * `stubGateway`, `inMemoryContent`, `refuseUnscriptedOperation`. This module
 * only assembles them into React providers. Reach for the SDK's first; a
 * hand-rolled double here encodes its author's model of a contract the SDK
 * already owns, which is the mistake SDK-DEBT M1 was raised for.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { vi, afterEach } from 'vitest';
import { SemiontBrowser, SessionSignals, type SemiontClient, type SemiontSession } from '@semiont/sdk';
import { createTestSession, stubGateway } from '@semiont/sdk/testing';
import { EventBus } from '@semiont/core';
import { TranslationProvider } from './contexts/TranslationContext';
import { LineNumbersProvider } from './contexts/LineNumbersContext';
import { ToastProvider } from './components/Toast';
import type { TranslationManager } from './types/TranslationManager';
import { SemiontProvider } from './session/SemiontProvider';

/**
  * Every fake browser below builds a REAL SemiontClient over the SDK's own
  * in-memory doubles — no HTTP, no localhost, no network. Clients are still
  * disposed at test end: a chain straddling teardown dies in the cache's B16
  * disposed-guard rather than logging while the vitest worker's RPC closes
  * (the `EnvironmentTeardownError` class CI hit). Registered at module scope:
  * every file that imports test-utils — exactly the files that create
  * clients — gets the hook.
  */
const liveTestClients: SemiontClient[] = [];
const liveTestBrowsers: SemiontBrowser[] = [];
afterEach(async () => {
  // Browsers first: `SemiontBrowser`'s constructor opens standing
  // subscriptions (kbs$/activeKbId$ persistence, the open-resources
  // projection) and owns an EventBus. These are REAL browsers, so leaving
  // them live leaks a growing set of subscriptions across a 179-file run.
  for (const browser of liveTestBrowsers.splice(0)) await browser.dispose();
  for (const client of liveTestClients.splice(0)) client.dispose();
});

/**
 * Minimal fake SemiontBrowser for tests. Emits a fake session whose `client`
 * is a fresh SemiontClient over in-memory transports. Tests that spy
 * on client methods (e.g. `BindNamespace.prototype.body`) rely on the
 * real-ish client surface. Tests that inspect events production code emits
 * subscribe via `client.on(channel, handler)`.
 */

function createFakeBrowserForTests(): SemiontBrowser {
  // A REAL `SemiontBrowser` over real in-memory collaborators — not a
  // look-alike. `SemiontBrowserConfig` is only `{storage, sessionFactory}`
  // and the class is transport-agnostic by design ("every HTTP-vs-local
  // construction concern lives in the factory"), so the double stops at the
  // transport layer and production code sees the production surface.
  // Both doubles refuse rather than invent: `stubGateway`'s ops reject by
  // name, and `FaultyTransport` now refuses unscripted bus operations by
  // default — so a unit that reaches something the test never scripted fails
  // saying which one.
  const { session, client, storage } = createTestSession({ gateway: stubGateway() });
  liveTestClients.push(client);
  const browser = new SemiontBrowser({ storage, sessionFactory: () => session });
  liveTestBrowsers.push(browser);
  // The browser populates these only by driving a real sign-in; tests want a
  // connected shape from the first render. Both values are real objects, so
  // seeding them states a fact rather than faking one.
  browser.activeSession$.next(session);
  browser.activeSignals$.next(new SessionSignals());
  return browser;
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
  /** Inject a specific SemiontBrowser (e.g. one seeded with a kbs list). */
  browser?: SemiontBrowser;
}

/**
 * Test access to the client's local bus. Production code uses typed
 * namespace methods or `session.subscribe(channel, handler)` — never
 * direct bus access. Tests need raw subjects to drive `bus.get(channel).next(...)`
 * / `subscribe(...)` against the live client wiring; `client.bus` is
 * read-only public for that.
 */
function busOf(client: SemiontClient): EventBus {
  return client.bus;
}

export interface RenderWithProvidersOptions extends TestProvidersOptions, Omit<RenderOptions, 'wrapper'> {
  /**
   * If true, returns the session (client) EventBus — session-scoped
   * channels (mark:*, beckon:*, gather:*, match:*, bind:*, yield:*,
   * browse:click, browse:resource-open, browse:entity-type-clicked).
   */
  returnEventBus?: boolean;
  /**
   * If true, returns the `SemiontBrowser` itself, whose `stream(channel)`
   * reads the app-scoped channels — panel:*, shell:*, tabs:*, nav:*,
   * settings:*. (Its bus is private; `stream` is the published reader.)
   */
  returnShellBus?: boolean;
}

export interface RenderWithProvidersResult extends RenderResult {
  /** Session-scoped bus (from the client inside the browser). */
  eventBus?: EventBus;
  /** The browser — `browser.stream(channel)` reads app-scoped channels. */
  browser?: SemiontBrowser;
  /** The session — pass as the `session` prop to provider-free components. */
  session: SemiontSession | null;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderWithProvidersOptions
): RenderWithProvidersResult {
  const {
    translationManager = defaultMocks.translationManager,
    browser,
    returnEventBus = false,
    returnShellBus = false,
    ...renderOptions
  } = options || {};

  const fakeBrowser = browser ?? createFakeBrowserForTests();
  const fakeSession = fakeBrowser.activeSession$.getValue();
  const client = fakeSession?.client;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <SemiontProvider browser={fakeBrowser}>
          <ToastProvider>
            <LineNumbersProvider>
              {children}
            </LineNumbersProvider>
          </ToastProvider>
        </SemiontProvider>
      </TranslationProvider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...renderOptions });

  const extras: Partial<RenderWithProvidersResult> = {};
  if (returnEventBus && client) extras.eventBus = busOf(client);
  if (returnShellBus) extras.browser = fakeBrowser;
  return { ...result, session: fakeSession, ...extras };
}

/**
 * Build a minimal `<SemiontProvider>` wrapper for tests that roll their
 * own render wrapper (instead of `renderWithProviders`). The returned
 * `eventBus` is the bus backing the fake session's client — same
 * reference production code pokes via `session.client.emit(...)`.
 */
export function createTestSemiontWrapper(): {
  SemiontWrapper: React.ComponentType<{ children: React.ReactNode }>;
  /** Session-scoped bus (from the client). */
  eventBus: EventBus;
  /** The browser — `browser.stream(channel)` reads app-scoped channels. */
  browser: SemiontBrowser;
  /** The session's client — for tests that need to spy on namespace methods. */
  client: SemiontClient;
  /** The session — pass as the `session` prop to provider-free components. */
  session: SemiontSession;
} {
  const fakeBrowser = createFakeBrowserForTests();
  const fakeSession = fakeBrowser.activeSession$.getValue()!;
  const client = fakeSession.client;
  const SemiontWrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontProvider browser={fakeBrowser}>{children}</SemiontProvider>
  );
  return {
    SemiontWrapper,
    eventBus: busOf(client),
    browser: fakeBrowser,
    client,
    session: fakeSession,
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
 * Build a fake SemiontBrowser with the active SessionSignals
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
  const browser = createFakeBrowserForTests();
  const signals = browser.activeSignals$.getValue()!;

  // Push the flags the modal reads. These are the same BehaviorSubjects
  // production writes through `notifySessionExpired` / `notifyPermissionDenied`.
  if (overrides.permissionDeniedAt !== undefined) {
    signals.permissionDeniedAt$.next(overrides.permissionDeniedAt);
  }
  if (overrides.permissionDeniedMessage !== undefined) {
    signals.permissionDeniedMessage$.next(overrides.permissionDeniedMessage);
  }
  if (overrides.sessionExpiredAt !== undefined) {
    signals.sessionExpiredAt$.next(overrides.sessionExpiredAt);
  }
  if (overrides.sessionExpiredMessage !== undefined) {
    signals.sessionExpiredMessage$.next(overrides.sessionExpiredMessage);
  }

  // Spies on the REAL methods, not replacements for them: a test asserting
  // "the modal acknowledged" is asserting about the method production calls.
  if (overrides.acknowledgePermissionDenied) {
    vi.spyOn(signals, 'acknowledgePermissionDenied').mockImplementation(
      overrides.acknowledgePermissionDenied,
    );
  }
  if (overrides.acknowledgeSessionExpired) {
    vi.spyOn(signals, 'acknowledgeSessionExpired').mockImplementation(
      overrides.acknowledgeSessionExpired,
    );
  }

  return browser;
}

// Re-export testing library utilities
export * from '@testing-library/react';
export { vi } from 'vitest';
