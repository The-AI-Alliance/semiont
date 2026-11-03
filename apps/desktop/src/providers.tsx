import type { ReactNode } from 'react';
import { ErrorBoundary, TranslationProvider } from '@semiont/react-ui';

/**
 * What every react-ui component chat renders needs above it.
 *
 * This provider is where chat states its language: English, as chat's own copy is.
 * react-ui's annotation entries read it from here, and each `ResourceViewer` is handed its
 * manager (`useTranslationManager()`) as the language prop the viewer requires. The
 * boundary sits outside the provider, so a component that fails to render, or a locale that fails to load, shows the failure
 * instead of leaving an empty window.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary fallback={(error, reset) => <RenderFailure error={error} onRetry={reset} />}>
      <TranslationProvider locale="en" loadingComponent={<p className="app__connecting">Loading…</p>}>
        {children}
      </TranslationProvider>
    </ErrorBoundary>
  );
}

function RenderFailure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="app__failure" role="alert">
      <p>Something went wrong drawing this screen.</p>
      <p className="app__failure-detail">{error.message}</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
