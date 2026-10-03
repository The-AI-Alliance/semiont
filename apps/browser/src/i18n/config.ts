import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';
import { LOCALE_CODES, type LocaleCode } from '@semiont/core';

export function isSupportedLocale(locale: string): locale is LocaleCode {
  return (LOCALE_CODES as readonly string[]).includes(locale);
}

i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    // The translation namespace matches the flat JSON structure in messages/*.json
    // (a single file per locale with all namespaces as top-level keys)
    ns: ['translation'],
    defaultNS: 'translation',
    // No language stands in for another: a locale's own bundle or nothing
    fallbackLng: false,
    supportedLngs: [...LOCALE_CODES],
    backend: {
      loadPath: '/messages/{{lng}}.json',
    },
    interpolation: {
      // React handles XSS escaping
      escapeValue: false,
    },
    // Don't initialize until a locale is selected
    initAsync: false,
  });

// <html lang> and <html dir> name the language on screen (WCAG 3.1.1), so they
// change when i18next has switched to it, not when the route asks for it.
i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language;
  document.documentElement.dir = i18n.dir(language);
});

export default i18n;
