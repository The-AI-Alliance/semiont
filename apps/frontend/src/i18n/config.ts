import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';

export const SUPPORTED_LOCALES = [
  'ar', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi',
  'fr', 'he', 'hi', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no',
  'pl', 'pt', 'ro', 'sv', 'th', 'tr', 'uk', 'vi', 'zh',
] as const;

export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    // The translation namespace matches the flat JSON structure in messages/*.json
    // (a single file per locale with all namespaces as top-level keys)
    ns: ['translation'],
    defaultNS: 'translation',
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    backend: {
      loadPath: '/messages/{{lng}}.json',
    },
    interpolation: {
      // React handles XSS escaping
      escapeValue: false,
    },
    // Don't initialize until a locale is selected
    initImmediate: false,
  });

export default i18n;
