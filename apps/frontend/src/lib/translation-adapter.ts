/**
 * Translation adapter for bridging next-intl with @semiont/react-ui
 *
 * This adapter allows the frontend to provide translations to react-ui components
 * using next-intl as the underlying i18n implementation.
 */

import { useTranslations as useNextIntlTranslations } from 'next-intl';
import type { TranslationManager } from '@semiont/react-ui';
import enReactUI from '@semiont/react-ui/translations/en.json';
import esReactUI from '@semiont/react-ui/translations/es.json';

// Type for the react-ui translation structure
type ReactUITranslations = typeof enReactUI;

// Map of locale codes to react-ui translations
const reactUITranslations: Record<string, ReactUITranslations> = {
  en: enReactUI,
  es: esReactUI,
};

/**
 * Creates a TranslationManager that combines next-intl translations
 * with react-ui's component translations
 *
 * @param locale - The current locale (e.g., 'en', 'es')
 * @param messages - The app's translation messages (frontend-specific)
 * @returns TranslationManager implementation for react-ui
 */
export function createTranslationManager(
  locale: string,
  messages: Record<string, any>
): TranslationManager {
  // Merge frontend messages with react-ui translations
  const combinedMessages = {
    ...messages,
    ...reactUITranslations[locale] || reactUITranslations['en'], // Fallback to English
  };

  return {
    t: (namespace: string, key: string, params?: Record<string, any>) => {
      // Navigate to the namespace in the combined messages
      const namespaceMessages = combinedMessages[namespace];

      if (!namespaceMessages) {
        console.warn(`Translation namespace "${namespace}" not found`);
        return `${namespace}.${key}`;
      }

      // Get the translation for the key
      let translation = namespaceMessages[key];

      if (!translation) {
        console.warn(`Translation key "${key}" not found in namespace "${namespace}"`);
        return `${namespace}.${key}`;
      }

      // Handle parameter interpolation if needed
      if (params && typeof translation === 'string') {
        Object.entries(params).forEach(([paramKey, paramValue]) => {
          translation = translation.replace(`{${paramKey}}`, String(paramValue));
        });
      }

      return translation;
    },
  };
}

/**
 * Hook to create a TranslationManager using the current locale from next-intl
 *
 * @returns TranslationManager for use with react-ui's TranslationProvider
 */
export function useTranslationManager(): TranslationManager {
  // This is a simplified version - in practice you'd get locale and messages
  // from next-intl's context or props

  // For now, we'll create a manager that uses next-intl's useTranslations
  // for each namespace dynamically
  return {
    t: (namespace: string, key: string, params?: Record<string, any>) => {
      try {
        // Try to use next-intl's translation for this namespace
        // This will work for namespaces that exist in the frontend
        const t = useNextIntlTranslations(namespace);
        return params ? t(key, params) : t(key);
      } catch (error) {
        // If namespace doesn't exist in frontend, try react-ui translations
        // This requires access to the current locale
        console.warn(`Using fallback for ${namespace}.${key}`);
        return `${namespace}.${key}`;
      }
    },
  };
}

/**
 * Server-side function to create a TranslationManager
 * Use this in server components or when you have access to locale and messages
 *
 * @param locale - The current locale
 * @param getTranslations - Function to get translations for a namespace
 * @returns TranslationManager for server-side usage
 */
export function createServerTranslationManager(
  locale: string,
  getTranslations: (namespace: string) => any
): TranslationManager {
  return {
    t: (namespace: string, key: string, params?: Record<string, any>) => {
      try {
        const t = getTranslations(namespace);
        const translation = t(key);

        if (params && typeof translation === 'string') {
          let result = translation;
          Object.entries(params).forEach(([paramKey, paramValue]) => {
            result = result.replace(`{${paramKey}}`, String(paramValue));
          });
          return result;
        }

        return translation;
      } catch (error) {
        // Fallback to react-ui translations if available
        const reactUIMessages = reactUITranslations[locale] || reactUITranslations['en'];
        const namespaceMessages = reactUIMessages[namespace as keyof ReactUITranslations];

        if (namespaceMessages && namespaceMessages[key]) {
          let translation = namespaceMessages[key];

          if (params && typeof translation === 'string') {
            Object.entries(params).forEach(([paramKey, paramValue]) => {
              translation = translation.replace(`{${paramKey}}`, String(paramValue));
            });
          }

          return translation;
        }

        return `${namespace}.${key}`;
      }
    },
  };
}