'use client';

import { createContext, useContext, ReactNode, useState, useEffect, useMemo } from 'react';
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

// List of available locales (can be extended without importing all files)
export const AVAILABLE_LOCALES = [
  'ar', // Arabic
  'bn', // Bengali
  'cs', // Czech
  'da', // Danish
  'de', // German
  'el', // Greek
  'en', // English
  'es', // Spanish
  'fa', // Persian/Farsi
  'fi', // Finnish
  'fr', // French
  'he', // Hebrew
  'hi', // Hindi
  'id', // Indonesian
  'it', // Italian
  'ja', // Japanese
  'ko', // Korean
  'ms', // Malay
  'nl', // Dutch
  'no', // Norwegian
  'pl', // Polish
  'pt', // Portuguese
  'ro', // Romanian
  'sv', // Swedish
  'th', // Thai
  'tr', // Turkish
  'uk', // Ukrainian
  'vi', // Vietnamese
  'zh', // Chinese
] as const;
export type AvailableLocale = typeof AVAILABLE_LOCALES[number];

// Lazy load translations for a specific locale
async function loadTranslations(locale: string): Promise<Messages> {
  const cached = translationCache.get(locale);
  if (cached) return cached;

  const translations = await import(`../../translations/${locale}.json`);
  const messages: Messages = translations.default || translations;
  translationCache.set(locale, messages);
  return messages;
}

export type TranslationProviderProps =
  | {
      /** A complete TranslationManager implementation */
      translationManager: TranslationManager;
      locale?: never;
      loadingComponent?: never;
      children: ReactNode;
    }
  | {
      /** Built-in translations for this locale, one of AVAILABLE_LOCALES */
      locale: string;
      /** Shown while the locale's translations are being loaded */
      loadingComponent?: ReactNode;
      translationManager?: never;
      children: ReactNode;
    };

/**
 * Provider for translation management
 *
 * Two modes of operation, and no language is assumed in either:
 * 1. With translationManager: uses that translation implementation
 * 2. With locale: dynamically loads the built-in translations for that locale.
 *    A locale whose translations cannot be loaded is an error.
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
  const [loaded, setLoaded] = useState<LoadedTranslations | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
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
  return (key: string, params?: Record<string, any>) => manager.t(namespace, key, params);
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