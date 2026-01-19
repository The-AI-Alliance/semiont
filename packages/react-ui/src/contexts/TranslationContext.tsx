'use client';

import React, { createContext, useContext, ReactNode, useState, useEffect, useMemo } from 'react';
import type { TranslationManager } from '../types/TranslationManager';

// Static import for default English only - always needed as fallback
import enTranslations from '../../translations/en.json';

const TranslationContext = createContext<TranslationManager | null>(null);

// Cache for dynamically loaded translations
const translationCache = new Map<string, any>();

/**
 * Process ICU MessageFormat plural syntax
 * Supports: {count, plural, =0 {text} =1 {text} other {text}}
 */
function processPluralFormat(text: string, params: Record<string, any>): string {
  // Match {paramName, plural, ...} with proper brace counting
  const pluralMatch = text.match(/\{(\w+),\s*plural,\s*/);
  if (!pluralMatch) return text;

  const paramName = pluralMatch[1];
  const count = params[paramName];
  if (count === undefined) return text;

  // Find the matching closing brace by counting
  let startPos = pluralMatch[0].length;
  let braceCount = 1; // We're inside the first {
  let endPos = startPos;

  for (let i = startPos; i < text.length; i++) {
    if (text[i] === '{') braceCount++;
    else if (text[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endPos = i;
        break;
      }
    }
  }

  const pluralCases = text.substring(startPos, endPos);

  // Parse plural cases: =0 {text} =1 {text} other {text}
  const cases: Record<string, string> = {};
  const caseRegex = /(?:=(\d+)|(\w+))\s*\{([^}]+)\}/g;
  let caseMatch;

  while ((caseMatch = caseRegex.exec(pluralCases)) !== null) {
    const [, exactNumber, keyword, textContent] = caseMatch;
    const key = exactNumber !== undefined ? `=${exactNumber}` : keyword;
    cases[key] = textContent;
  }

  // Select appropriate case
  const exactMatch = cases[`=${count}`];
  if (exactMatch !== undefined) {
    const result = exactMatch.replace(/#/g, String(count));
    return text.substring(0, pluralMatch.index!) + result + text.substring(endPos + 1);
  }

  const otherCase = cases['other'];
  if (otherCase !== undefined) {
    const result = otherCase.replace(/#/g, String(count));
    return text.substring(0, pluralMatch.index!) + result + text.substring(endPos + 1);
  }

  return text;
}

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
async function loadTranslations(locale: string): Promise<any> {
  // Check cache first
  if (translationCache.has(locale)) {
    return translationCache.get(locale);
  }

  // English is already loaded statically
  if (locale === 'en') {
    translationCache.set('en', enTranslations);
    return enTranslations;
  }

  try {
    // Dynamic import for all other locales
    const translations = await import(`../../translations/${locale}.json`);
    const translationData = translations.default || translations;
    translationCache.set(locale, translationData);
    return translationData;
  } catch (error) {
    console.error(`Failed to load translations for locale: ${locale}`, error);
    // Fall back to English
    return enTranslations;
  }
}

// Default English translation manager (using static import)
const defaultTranslationManager: TranslationManager = {
  t: (namespace: string, key: string, params?: Record<string, any>) => {
    const translations = enTranslations as Record<string, Record<string, string>>;
    const translation = translations[namespace]?.[key];

    if (!translation) {
      console.warn(`Translation not found for ${namespace}.${key}`);
      return `${namespace}.${key}`;
    }

    // Handle parameter interpolation and plural format
    if (params && typeof translation === 'string') {
      let result = translation;
      // First process plural format
      result = processPluralFormat(result, params);
      // Then handle simple parameter interpolation
      Object.entries(params).forEach(([paramKey, paramValue]) => {
        result = result.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
      });
      return result;
    }

    return translation;
  },
};

export interface TranslationProviderProps {
  /**
   * Option 1: Provide a complete TranslationManager implementation
   */
  translationManager?: TranslationManager;

  /**
   * Option 2: Use built-in translations by specifying a locale
   * When adding new locales, just add the JSON file and update AVAILABLE_LOCALES
   */
  locale?: string;

  /**
   * Loading component to show while translations are being loaded
   * Only relevant when using dynamic locale loading
   */
  loadingComponent?: ReactNode;

  children: ReactNode;
}

/**
 * Provider for translation management with dynamic loading
 *
 * Three modes of operation:
 * 1. No provider: Components use default English strings
 * 2. With locale prop: Dynamically loads translations for that locale
 * 3. With translationManager: Use custom translation implementation
 */
export function TranslationProvider({
  translationManager,
  locale,
  loadingComponent = null,
  children,
}: TranslationProviderProps) {
  const [loadedTranslations, setLoadedTranslations] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load translations when locale changes
  useEffect(() => {
    if (locale && !translationManager) {
      setIsLoading(true);
      loadTranslations(locale)
        .then(translations => {
          setLoadedTranslations(translations);
          setIsLoading(false);
        })
        .catch(error => {
          console.error('Failed to load translations:', error);
          setLoadedTranslations(enTranslations); // Fall back to English
          setIsLoading(false);
        });
    }
  }, [locale, translationManager]);

  // Create translation manager from loaded translations
  const localeManager = useMemo<TranslationManager | null>(() => {
    if (!loadedTranslations) return null;

    return {
      t: (namespace: string, key: string, params?: Record<string, any>) => {
        const translation = loadedTranslations[namespace]?.[key];

        if (!translation) {
          console.warn(`Translation not found for ${namespace}.${key} in locale ${locale}`);
          return `${namespace}.${key}`;
        }

        // Handle parameter interpolation and plural format
        if (params && typeof translation === 'string') {
          let result = translation;
          // First process plural format
          result = processPluralFormat(result, params);
          // Then handle simple parameter interpolation
          Object.entries(params).forEach(([paramKey, paramValue]) => {
            result = result.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
          });
          return result;
        }

        return translation;
      },
    };
  }, [loadedTranslations, locale]);

  // If custom translation manager provided, use it
  if (translationManager) {
    return (
      <TranslationContext.Provider value={translationManager}>
        {children}
      </TranslationContext.Provider>
    );
  }

  // If locale provided and still loading, show loading component
  if (locale && isLoading) {
    return <>{loadingComponent}</>;
  }

  // If locale provided and translations loaded, use them
  if (locale && localeManager) {
    return (
      <TranslationContext.Provider value={localeManager}>
        {children}
      </TranslationContext.Provider>
    );
  }

  // Default: use English translations
  return (
    <TranslationContext.Provider value={defaultTranslationManager}>
      {children}
    </TranslationContext.Provider>
  );
}

/**
 * Hook to access translations within a namespace
 *
 * Works in three modes:
 * 1. Without provider: Returns default English translations
 * 2. With provider using locale: Returns dynamically loaded translations for that locale
 * 3. With custom provider: Uses the custom translation manager
 *
 * @param namespace - Translation namespace (e.g., 'Toolbar', 'ResourceViewer')
 * @returns Function to translate keys within the namespace
 */
export function useTranslations(namespace: string) {
  const context = useContext(TranslationContext);

  // If no context (no provider), use default English translations
  if (!context) {
    return (key: string, params?: Record<string, any>) => {
      const translations = enTranslations as Record<string, Record<string, string>>;
      const translation = translations[namespace]?.[key];

      if (!translation) {
        console.warn(`Translation not found for ${namespace}.${key}`);
        return `${namespace}.${key}`;
      }

      // Handle parameter interpolation and plural format
      if (params && typeof translation === 'string') {
        let result = translation;
        // First process plural format
        result = processPluralFormat(result, params);
        // Then handle simple parameter interpolation
        Object.entries(params).forEach(([paramKey, paramValue]) => {
          result = result.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
        });
        return result;
      }

      return translation;
    };
  }

  // Return a function that translates keys within this namespace
  return (key: string, params?: Record<string, any>) => context.t(namespace, key, params);
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