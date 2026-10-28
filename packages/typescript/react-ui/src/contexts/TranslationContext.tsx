'use client';

import { createContext, useContext, ReactNode, useState, useEffect, useMemo } from 'react';
import type { LocaleCode } from '@semiont/core';
import type { TranslationManager } from '../types/TranslationManager';
import { createTranslationManager, type Messages } from '../lib/translation-manager';

const TranslationContext = createContext<TranslationManager | null>(null);

// Messages, and the locale they were loaded for.
interface LoadedTranslations {
  locale: string;
  messages: Messages;
}

// Cache for dynamically loaded translations
const translationCache = new Map<string, Messages>();

// Lazy load translations for a specific locale
async function loadTranslations(locale: string): Promise<Messages> {
  const cached = translationCache.get(locale);
  if (cached) return cached;

  const translations = await import(`../../translations/${locale}.json`);
  const messages: Messages = translations.default || translations;
  translationCache.set(locale, messages);
  return messages;
}

/**
 * Where a subtree's strings come from: a whole `TranslationManager` the host
 * built, or one of react-ui's own locales. Exactly one, and no default:
 * react-ui assumes no language. `TranslationProvider` takes it, and so does
 * every component a host can mount on its own, which mounts its own provider
 * from it.
 */
export type TranslationSource =
  | {
      /** A complete TranslationManager implementation */
      translationManager: TranslationManager;
      locale?: never;
      loadingComponent?: never;
    }
  | {
      /** Built-in translations for this locale */
      locale: LocaleCode;
      /** Shown while the locale's translations are first being loaded */
      loadingComponent?: ReactNode;
      translationManager?: never;
    };

export type TranslationProviderProps = TranslationSource & { children: ReactNode };

/**
 * Provider for translation management
 *
 * Two modes of operation, and no language is assumed in either:
 * 1. With translationManager: uses that translation implementation
 * 2. With locale: dynamically loads the built-in translations for that locale.
 *    A locale whose translations cannot be loaded is an error. Once a locale's
 *    strings are loaded, every provider of that locale renders at once.
 */
export function TranslationProvider(props: TranslationProviderProps) {
  if (props.translationManager) {
    return (
      <TranslationContext.Provider value={props.translationManager}>
        {props.children}
      </TranslationContext.Provider>
    );
  }

  return (
    <LocaleTranslations locale={props.locale} loadingComponent={props.loadingComponent}>
      {props.children}
    </LocaleTranslations>
  );
}

function LocaleTranslations({
  locale,
  loadingComponent,
  children,
}: {
  locale: string;
  loadingComponent: ReactNode;
  children: ReactNode;
}) {
  // A locale already loaded is there at the first render: a page that mounts
  // a provider per viewer does not see each one start blank.
  const [loaded, setLoaded] = useState<LoadedTranslations | null>(() => {
    const messages = translationCache.get(locale);
    return messages ? { locale, messages } : null;
  });
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
    const cached = translationCache.get(locale);
    if (cached) {
      setLoaded((previous) => (previous?.locale === locale ? previous : { locale, messages: cached }));
      return;
    }
    let current = true;
    loadTranslations(locale).then(
      messages => {
        if (current) setLoaded({ locale, messages });
      },
      cause => {
        if (current) setFailure(new Error(`Failed to load translations for locale: ${locale}`, { cause }));
      },
    );
    return () => {
      current = false;
    };
  }, [locale]);

  const manager = useMemo(
    () => (loaded?.locale === locale ? createTranslationManager(loaded.locale, loaded.messages) : null),
    [loaded, locale],
  );

  // Thrown while rendering so the nearest error boundary sees it.
  if (failure) throw failure;

  if (!manager) {
    return <>{loadingComponent}</>;
  }

  return (
    <TranslationContext.Provider value={manager}>
      {children}
    </TranslationContext.Provider>
  );
}

/**
 * Hook to access translations within a namespace
 *
 * Reads the manager of the nearest TranslationProvider, and throws when there
 * is none.
 *
 * @param namespace - Translation namespace (e.g., 'Toolbar', 'ResourceViewer')
 * @returns Function to translate keys within the namespace
 */
export function useTranslations(namespace: string) {
  const manager = useContext(TranslationContext);
  if (!manager) {
    throw new Error('useTranslations must be used within a TranslationProvider');
  }

  // Return a function that translates keys within this namespace
  return (key: string, params?: Record<string, unknown>) => manager.t(namespace, key, params);
}

/**
 * The nearest TranslationProvider's manager, for a component that hands the
 * language on to a view that takes it as a prop, as `ResourceViewerPage` hands
 * it to `ResourceViewer`. Throws when there is none, as `useTranslations` does.
 */
export function useTranslationManager(): TranslationManager {
  const manager = useContext(TranslationContext);
  if (!manager) {
    throw new Error('useTranslationManager must be used within a TranslationProvider');
  }
  return manager;
}

/**
 * Hook to preload translations for a locale
 * Useful for preloading translations before navigation
 */
export function usePreloadTranslations() {
  return {
    preload: async (locale: string) => {
      try {
        await loadTranslations(locale);
        return true;
      } catch (error) {
        console.error(`Failed to preload translations for ${locale}:`, error);
        return false;
      }
    },
    isLoaded: (locale: string) => translationCache.has(locale),
  };
}