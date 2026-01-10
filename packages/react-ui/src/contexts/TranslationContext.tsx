'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import type { TranslationManager } from '../types/TranslationManager';

// Import built-in translations
import enTranslations from '../../translations/en.json';
import esTranslations from '../../translations/es.json';

const TranslationContext = createContext<TranslationManager | null>(null);

// Built-in locale translations
const builtInTranslations: Record<string, any> = {
  en: enTranslations,
  es: esTranslations,
};

// Default English translation manager
const defaultTranslationManager: TranslationManager = {
  t: (namespace: string, key: string, params?: Record<string, any>) => {
    const translations = enTranslations as Record<string, Record<string, string>>;
    const translation = translations[namespace]?.[key];

    if (!translation) {
      console.warn(`Translation not found for ${namespace}.${key}`);
      return `${namespace}.${key}`;
    }

    // Handle parameter interpolation
    if (params && typeof translation === 'string') {
      let result = translation;
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
   */
  locale?: 'en' | 'es';

  children: ReactNode;
}

/**
 * Provider for translation management
 *
 * Three modes of operation:
 * 1. No provider: Components use default English strings
 * 2. With locale prop: Use built-in translations for that locale
 * 3. With translationManager: Use custom translation implementation
 */
export function TranslationProvider({
  translationManager,
  locale,
  children,
}: TranslationProviderProps) {
  // If custom translation manager provided, use it
  if (translationManager) {
    return (
      <TranslationContext.Provider value={translationManager}>
        {children}
      </TranslationContext.Provider>
    );
  }

  // If locale provided, create a translation manager for that locale
  if (locale) {
    const localeTranslations = builtInTranslations[locale] || enTranslations;
    const localeManager: TranslationManager = {
      t: (namespace: string, key: string, params?: Record<string, any>) => {
        const translation = localeTranslations[namespace]?.[key];

        if (!translation) {
          console.warn(`Translation not found for ${namespace}.${key} in locale ${locale}`);
          return `${namespace}.${key}`;
        }

        // Handle parameter interpolation
        if (params && typeof translation === 'string') {
          let result = translation;
          Object.entries(params).forEach(([paramKey, paramValue]) => {
            result = result.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
          });
          return result;
        }

        return translation;
      },
    };

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
 * 2. With provider using locale: Returns translations for that locale
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

      // Handle parameter interpolation
      if (params && typeof translation === 'string') {
        let result = translation;
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
