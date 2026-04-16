import React from 'react';
import {
  ToastProvider,
  LiveRegionProvider,
  TranslationProvider,
  ThemeProvider,
  EventBusProvider,
} from '@semiont/react-ui';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { NavigationHandler } from '@/components/knowledge/NavigationHandler';
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

/**
 * Root Provider Composition for Semiont Frontend.
 *
 * Wires up GLOBAL contexts that every page needs — auth-independent.
 *
 * Auth-dependent providers (KnowledgeBaseSessionProvider, ProtectedErrorBoundary,
 * SessionExpiredModal, PermissionDeniedModal) are bundled in `AuthShell` and
 * mounted only in protected layouts (know/, admin/, moderate/, auth/welcome/).
 * Pre-app routes (landing, OAuth flow) intentionally do NOT mount AuthShell —
 * they have no need to validate JWTs.
 *
 * ApiClientProvider is added in feature-specific layouts (e.g. /know) that
 * require API access. Public pages don't need it.
 *
 * Provider order — outer to inner:
 * 1. TranslationProvider     — i18n
 * 2. ToastProvider           — toast notifications
 * 3. LiveRegionProvider      — a11y live region
 * 4. KeyboardShortcutsProvider — keyboard shortcuts
 * 5. ThemeProvider           — theme
 * 6. EventBusProvider        — RxJS event bus
 *    + NavigationHandler
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const translationManager = useMergedTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>
      <ToastProvider>
        <LiveRegionProvider>
          <KeyboardShortcutsProvider>
            <ThemeProvider>
              <EventBusProvider>
                <NavigationHandler />
                {children}
              </EventBusProvider>
            </ThemeProvider>
          </KeyboardShortcutsProvider>
        </LiveRegionProvider>
      </ToastProvider>
    </TranslationProvider>
  );
}
