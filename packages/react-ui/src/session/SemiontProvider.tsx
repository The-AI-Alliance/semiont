'use client';

/**
 * SemiontProvider — the single React provider for session state.
 * Puts the module-scoped SemiontBrowser singleton into context so
 * `useSemiont()` can hand it back. Does not own the browser's lifetime
 * — the browser lives outside React, constructed lazily by `getBrowser()`
 * and disposed only via `__resetForTests` (never in production).
 *
 * Defaults to `WebBrowserStorage` + `createHttpSessionFactory()` (the
 * canonical web setup). Hosts that need a different shape — Electron /
 * Tauri with a filesystem-backed storage, an in-process session factory
 * built around `LocalTransport`, etc. — pass `storage` and/or
 * `sessionFactory` to override the defaults. Tests typically construct
 * a `SemiontBrowser` directly and inject it via `browser`.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  SemiontBrowser,
  createHttpSessionFactory,
  getBrowser,
  type SessionFactory,
  type SessionStorage,
} from '@semiont/sdk';
import { WebBrowserStorage } from './web-browser-storage';

const SemiontContext = createContext<SemiontBrowser | null>(null);

export interface SemiontProviderProps {
  /** Inject a fully-constructed browser (tests, embedded hosts that build their own). Omit to use the default. */
  browser?: SemiontBrowser;
  /** Override the default `WebBrowserStorage`. Useful for non-browser hosts (Electron/Tauri filesystem-backed adapters). */
  storage?: SessionStorage;
  /** Override the default HTTP session factory. Useful for in-process or future non-HTTP transports. */
  sessionFactory?: SessionFactory;
  children: ReactNode;
}

export function SemiontProvider({ browser, storage, sessionFactory, children }: SemiontProviderProps) {
  // `useMemo` here is a stable read, not a factory: `getBrowser()` returns
  // the module singleton, so re-renders observe the same instance. The
  // first call to `getBrowser` wins; subsequent renders see the same
  // instance regardless of prop changes.
  const value = useMemo(
    () => browser ?? getBrowser({
      storage: storage ?? new WebBrowserStorage(),
      sessionFactory: sessionFactory ?? createHttpSessionFactory(),
    }),
    [browser, storage, sessionFactory],
  );
  return <SemiontContext.Provider value={value}>{children}</SemiontContext.Provider>;
}

export function useSemiont(): SemiontBrowser {
  const ctx = useContext(SemiontContext);
  if (!ctx) {
    throw new Error('useSemiont must be used within a <SemiontProvider>');
  }
  return ctx;
}
