import { useMemo } from 'react';
import { useMessages, useLocale } from 'next-intl';
import type { TranslationManager } from '@semiont/react-ui';

// Import English react-ui translations as fallback
// We'll statically include these since dynamic imports are problematic
import reactUIEnglish from '../../../../packages/react-ui/translations/en.json';

// Type for translation messages
type Messages = Record<string, Record<string, string>>;

/**
 * Merged Translation Manager
 *
 * This manager merges translations from two sources:
 * 1. Frontend app translations (apps/frontend/messages/[locale].json)
 * 2. React UI package translations (packages/react-ui/translations/[locale].json)
 *
 * This ensures that:
 * - Frontend-specific components get their translations
 * - React UI components get their built-in translations
 * - No "translation not found" errors occur
 *
 * Note: Currently only supports English react-ui translations.
 * To support other locales, we would need to copy react-ui translations
 * to the public folder or find a way to import them dynamically.
 */
export function useMergedTranslationManager(): TranslationManager {
  const frontendMessages = useMessages();
  const locale = useLocale();

  return useMemo(() => {
    const typedFrontendMessages = frontendMessages as Messages;
    const reactUIMessages = reactUIEnglish as Messages;

    return {
      t: (namespace: string, key: string, params?: Record<string, any>): string => {
        // First, check frontend messages
        let translation = typedFrontendMessages[namespace]?.[key];

        // If not found in frontend, check react-ui messages
        if (!translation) {
          translation = reactUIMessages[namespace]?.[key];
        }

        // If still not found, warn and return namespace.key format
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
  }, [frontendMessages, locale]);
}