import { useMemo } from 'react';
import { useMessages, useLocale } from 'next-intl';
import type { TranslationManager } from '@semiont/react-ui';

// Import react-ui translations
import enReactUI from '../../../../packages/react-ui/translations/en.json';
import esReactUI from '../../../../packages/react-ui/translations/es.json';

// Map of locale codes to react-ui translations
const reactUITranslations: Record<string, any> = {
  en: enReactUI,
  es: esReactUI,
};

/**
 * Frontend implementation of TranslationManager
 * Wraps next-intl's useMessages to provide TranslationManager interface
 * and merges react-ui translations with frontend messages
 */
export function useTranslationManager(): TranslationManager {
  const messages = useMessages();
  const locale = useLocale();

  return useMemo(
    () => ({
      t: (namespace: string, key: string, params?: Record<string, any>): string => {
        // First check frontend messages
        const typedMessages = messages as Record<string, Record<string, string>>;
        let translation = typedMessages[namespace]?.[key];

        // If not found in frontend messages, check react-ui translations
        if (!translation) {
          const reactUIMessages = reactUITranslations[locale] || reactUITranslations['en'];
          translation = reactUIMessages[namespace]?.[key];
        }

        // If still not found, return namespace.key format
        if (!translation) {
          console.warn(`Translation not found: ${namespace}.${key}`);
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
    }),
    [messages, locale]
  );
}
