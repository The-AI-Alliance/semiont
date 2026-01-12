import { useMemo } from 'react';
import { useMessages } from 'next-intl';
import type { TranslationManager } from '@semiont/react-ui';

/**
 * Frontend implementation of TranslationManager
 * Wraps next-intl's useMessages to provide TranslationManager interface
 * for frontend-specific translations only. React-ui handles its own translations.
 */
export function useTranslationManager(): TranslationManager {
  const messages = useMessages();

  return useMemo(
    () => ({
      t: (namespace: string, key: string, params?: Record<string, any>): string => {
        // Only handle frontend messages
        // React-ui components will use their own built-in translations
        const typedMessages = messages as Record<string, Record<string, string>>;
        let translation = typedMessages[namespace]?.[key];

        // If not found, return namespace.key format
        if (!translation) {
          console.warn(`Translation not found in frontend messages: ${namespace}.${key}`);
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
    [messages]
  );
}
