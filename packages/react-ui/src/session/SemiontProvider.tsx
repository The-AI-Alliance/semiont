'use client';

/**
 * SemiontProvider — the single React provider for session state.
 * Puts the module-scoped SemiontBrowser singleton into context so
 * `useSemiont()` can hand it back. Does not own the browser's lifetime
 * — the browser lives outside React, constructed lazily by `getBrowser()`
 * and disposed only via `__resetForTests` (never in production).
 *
 * Defaults to `WebBrowserStorage` for persistence. Tests can inject a
 * different browser (and therefore a different storage).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { SemiontBrowser, getBrowser } from '@semiont/api-client';
import { WebBrowserStorage } from './web-browser-storage';

const SemiontContext = createContext<SemiontBrowser | null>(null);

export interface SemiontProviderProps {
  /** Inject a specific browser (tests). Omit in production. */
  browser?: SemiontBrowser;
  children: ReactNode;
}

export function SemiontProvider({ browser, children }: SemiontProviderProps) {
  // `useMemo` here is a stable read, not a factory: `getBrowser()` returns
  // the module singleton, so re-renders observe the same instance.
  const value = useMemo(
    () => browser ?? getBrowser({ storage: new WebBrowserStorage() }),
    [browser],
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
