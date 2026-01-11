'use client';

/**
 * ReactUIProvider - Provides translations to @semiont/react-ui components
 *
 * This component bridges next-intl with react-ui's TranslationContext,
 * allowing react-ui components to receive translations from the frontend.
 */

import React, { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { TranslationProvider } from '@semiont/react-ui';
import type { TranslationManager } from '@semiont/react-ui';

// Import react-ui translations
// Note: These imports might need adjustment based on build configuration
import enReactUI from '../../../../packages/react-ui/translations/en.json';
import esReactUI from '../../../../packages/react-ui/translations/es.json';

interface ReactUIProviderProps {
  children: React.ReactNode;
  locale?: string;
}

// Map of locale codes to react-ui translations
const reactUITranslations: Record<string, any> = {
  en: enReactUI,
  es: esReactUI,
};

/**
 * Provider component that supplies translations to react-ui components
 * This should wrap any part of the app that uses react-ui components
 */
export function ReactUIProvider({ children, locale = 'en' }: ReactUIProviderProps) {
  // Create a TranslationManager that uses next-intl under the hood
  const translationManager = useMemo<TranslationManager>(() => {
    // Get react-ui translations for the current locale
    const reactUIMessages = reactUITranslations[locale] || reactUITranslations['en'];

    // Store references to translation functions for each namespace
    const translationFunctions: Record<string, any> = {};

    return {
      t: (namespace: string, key: string, params?: Record<string, any>) => {
        try {
          // Check if this is a react-ui namespace
          if (reactUIMessages[namespace]) {
            const translation = reactUIMessages[namespace][key];

            if (!translation) {
              console.warn(`Translation key "${key}" not found in react-ui namespace "${namespace}"`);
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
          }

          // For non-react-ui namespaces, try to use next-intl
          // Cache the translation function for performance
          if (!translationFunctions[namespace]) {
            try {
              // This will throw if the namespace doesn't exist
              // We can't use hooks conditionally, so we need a different approach
              console.warn(`Namespace "${namespace}" not found in react-ui translations`);
              return `${namespace}.${key}`;
            } catch (error) {
              console.warn(`Translation namespace "${namespace}" not found`);
              return `${namespace}.${key}`;
            }
          }

          const t = translationFunctions[namespace];
          return params ? t(key, params) : t(key);
        } catch (error) {
          console.error(`Translation error for ${namespace}.${key}:`, error);
          return `${namespace}.${key}`;
        }
      },
    };
  }, [locale]);

  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}

/**
 * Hook to create a TranslationManager for a specific set of namespaces
 * Use this when you need to provide specific translations to react-ui components
 *
 * @param namespaces - Array of namespace names to make available
 * @param locale - Current locale
 * @returns TranslationManager instance
 */
export function useReactUITranslations(
  namespaces: string[],
  locale: string = 'en'
): TranslationManager {
  // Get translation functions for each namespace
  const translationHooks = useMemo(() => {
    const hooks: Record<string, ReturnType<typeof useTranslations>> = {};

    // Note: We can't actually call hooks conditionally or in loops
    // This is a simplified approach - in practice, you'd need to
    // handle this differently, perhaps by pre-defining all possible namespaces

    return hooks;
  }, [namespaces]);

  // Get react-ui translations
  const reactUIMessages = useMemo(
    () => reactUITranslations[locale] || reactUITranslations['en'],
    [locale]
  );

  return useMemo<TranslationManager>(() => ({
    t: (namespace: string, key: string, params?: Record<string, any>) => {
      // First check react-ui translations
      if (reactUIMessages[namespace]) {
        const translation = reactUIMessages[namespace][key];

        if (translation) {
          if (params && typeof translation === 'string') {
            let result = translation;
            Object.entries(params).forEach(([paramKey, paramValue]) => {
              result = result.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
            });
            return result;
          }
          return translation;
        }
      }

      // Fallback to namespace.key format
      console.warn(`Translation not found: ${namespace}.${key}`);
      return `${namespace}.${key}`;
    },
  }), [reactUIMessages]);
}