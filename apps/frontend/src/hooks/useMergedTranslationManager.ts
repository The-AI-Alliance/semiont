import { useMemo } from 'react';
import { useMessages, useLocale } from 'next-intl';
import type { TranslationManager } from '@semiont/react-ui';

// Type for translation messages
type Messages = Record<string, Record<string, string>>;

/**
 * Translation Manager for Frontend
 *
 * This provides a TranslationManager implementation that wraps next-intl.
 * The messages include both frontend-specific translations and react-ui translations,
 * which are merged at build time by scripts/merge-translations.js.
 *
 * This ensures:
 * - Frontend-specific components get their translations
 * - React UI components get their built-in translations
 * - All translations respect the user's selected locale
 * - No "translation not found" errors occur
 */
export function useMergedTranslationManager(): TranslationManager {
  const messages = useMessages();
  const locale = useLocale();

  return useMemo(() => {
    const typedMessages = messages as Messages;

    return {
      t: (namespace: string, key: string, params?: Record<string, any>): string => {
        // Look up translation in merged messages
        let translation = typedMessages[namespace]?.[key];

        // If not found, warn and return namespace.key format
        if (!translation) {
          // Only log in development to avoid console spam
          if (process.env.NODE_ENV === 'development') {
            console.warn(`Translation not found: ${namespace}.${key} (locale: ${locale})`);
          }
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
  }, [messages, locale]);
}