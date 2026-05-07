import React from 'react';
import {
  ToastProvider,
  LiveRegionProvider,
  TranslationProvider,
  ThemeProvider,
  SemiontProvider,
} from '@semiont/react-ui';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { NavigationHandler } from '@/components/knowledge/NavigationHandler';
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

/**
 * Root Provider Composition for Semiont Frontend.
 *
 * Wires up GLOBAL contexts that every page needs.
 *
 * The module-scoped `SemiontBrowser` singleton (KB list, active KB,
 * per-KB SemiontSession) is made available via `<SemiontProvider>` at
 * the app root — mounting it here is cheap because the singleton itself
 * survives every React re-render and route change.
 *
 * Auth-dependent UI (ProtectedErrorBoundary, SessionExpiredModal,
 * PermissionDeniedModal) is bundled in `AuthShell` and mounted only in
 * protected layouts (know/, admin/, moderate/, auth/welcome/). Pre-app
 * routes (landing, OAuth flow) intentionally do NOT mount AuthShell —
 * they have no session UI.
 *
 * The `SemiontClient` is owned by the per-KB `SemiontSession`, which
 * `SemiontBrowser` constructs on demand. Components read
 * `useObservable(useSemiont().activeSession$)?.client`.
 *
 * The event bus lives inside the client (owned by `SemiontSession`).
 * Components emit via `session?.emit(...)` and subscribe via
 * `useEventSubscription[s]`.
 *
 * Provider order — outer to inner:
 * 1. TranslationProvider     — i18n
 * 2. SemiontProvider         — SemiontBrowser singleton
 * 3. ToastProvider           — toast notifications
 * 4. LiveRegionProvider      — a11y live region
 * 5. KeyboardShortcutsProvider — keyboard shortcuts
 * 6. ThemeProvider           — theme
 *    + NavigationHandler
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const translationManager = useMergedTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>
      <SemiontProvider>
        <ToastProvider>
          <LiveRegionProvider>
            <KeyboardShortcutsProvider>
              <ThemeProvider>
                <NavigationHandler />
                {children}
              </ThemeProvider>
            </KeyboardShortcutsProvider>
          </LiveRegionProvider>
        </ToastProvider>
      </SemiontProvider>
    </TranslationProvider>
  );
}
