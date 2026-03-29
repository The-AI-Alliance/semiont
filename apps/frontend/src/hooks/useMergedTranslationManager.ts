import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TranslationManager } from '@semiont/react-ui';

type Messages = Record<string, Record<string, string>>;

/**
 * Translation Manager for Frontend
 *
 * Wraps react-i18next. The messages JSON (loaded by i18next-http-backend) has
 * the same flat namespace structure: { "Namespace": { "key": "value" } }.
 * TranslationManager.t(namespace, key) maps directly to this structure.
 */
export function useMergedTranslationManager(): TranslationManager {
  const { i18n } = useTranslation();

  return useMemo(() => {
    return {
      t: (namespace: string, key: string, params?: Record<string, unknown>): string => {
        const messages = i18n.getResourceBundle(i18n.language, 'translation') as Messages | undefined;
        let translation = messages?.[namespace]?.[key];

        if (!translation) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`Translation not found: ${namespace}.${key} (locale: ${i18n.language})`);
          }
          return `${namespace}.${key}`;
        }

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n, i18n.language]);
}
