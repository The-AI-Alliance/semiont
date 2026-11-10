import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { LOCALES, type LocaleCode } from '@semiont/core';
import { ErrorBoundary, TranslationProvider } from '@semiont/react-ui';
import { getPref, setPref } from './lib/prefs';

const LOCALE_KEY = 'locale';
interface DesktopLocaleContextValue {
  locale: LocaleCode;
  setLocale: (locale: LocaleCode) => Promise<void>;
  loaded: boolean;
}
const DesktopLocaleContext = createContext<DesktopLocaleContextValue | null>(null);

export function useDesktopLocale(): DesktopLocaleContextValue {
  const value = useContext(DesktopLocaleContext);
  if (value === null) throw new Error('useDesktopLocale must be used within AppProviders');
  return value;
}

/**
 * Providers every Desktop screen and react-ui component needs above it.
 *
 * The selected language is persisted in Desktop preferences and supplied to react-ui's
 * translation provider. App-specific copy remains English for now. Each `ResourceViewer`
 * is handed its manager (`useTranslationManager()`) as the language prop the viewer requires. The
 * boundary sits outside the provider, so a component that fails to render, or a locale that fails to load, shows the failure
 * instead of leaving an empty window.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>('en');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void getPref(LOCALE_KEY, 'en').then((saved) => {
      setLocaleState(LOCALES.find((entry) => entry.code === saved)?.code ?? 'en');
      setLoaded(true);
    });
  }, []);

  const setLocale = useCallback(async (nextLocale: LocaleCode) => {
    setLocaleState(nextLocale);
    await setPref(LOCALE_KEY, nextLocale);
  }, []);

  return (
    <ErrorBoundary fallback={(error, reset) => <RenderFailure error={error} onRetry={reset} />}>
      <DesktopLocaleContext.Provider value={{ locale, setLocale, loaded }}>
        <TranslationProvider locale={locale} loadingComponent={<p className="app__connecting">Loading…</p>}>
          {children}
        </TranslationProvider>
      </DesktopLocaleContext.Provider>
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
