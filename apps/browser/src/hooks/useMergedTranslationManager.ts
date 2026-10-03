import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { interpolateTranslation, type TranslationManager } from '@semiont/react-ui';

type Messages = Record<string, Record<string, string>>;

/**
 * Translation Manager for Frontend
 *
 * Wraps react-i18next. The messages JSON (loaded by i18next-http-backend) has
 * the same flat namespace structure: { "Namespace": { "key": "value" } }.
 * TranslationManager.t(namespace, key) maps directly to this structure.
 *
 * Interpolation is react-ui's `interpolateTranslation`, the one its built-in
 * managers use. It supports two syntaxes:
 *
 * - ICU MessageFormat plural — `{count, plural, =0 {…} one {…} other {…}}`
 *   — used for count-sensitive strings like "1 category selected" /
 *   "3 categories selected". The active language's plural rules decide
 *   which category a count falls in.
 * - Double-brace parameter substitution — `{{paramKey}}` — used for
 *   everything else (`{{mode}}`, `{{delay}}`, etc.).
 */
export function useMergedTranslationManager(): TranslationManager {
  const { i18n } = useTranslation();

  return useMemo(() => {
    return {
      t: (namespace: string, key: string, params?: Record<string, unknown>): string => {
        const messages = i18n.getResourceBundle(i18n.language, 'translation') as Messages | undefined;
        const translation = messages?.[namespace]?.[key];

        if (!translation) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`Translation not found: ${namespace}.${key} (locale: ${i18n.language})`);
          }
          return `${namespace}.${key}`;
        }

        if (params && typeof translation === 'string') {
          return interpolateTranslation(translation, params, i18n.language);
        }

        return translation;
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n, i18n.language]);
}
