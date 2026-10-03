import { Link } from 'react-router';
import { getLocaleNativeName } from '@semiont/core';
import { AVAILABLE_LOCALES, MainContent } from '@semiont/react-ui';

function nativeName(locale: string): string {
  const name = getLocaleNativeName(locale);
  if (!name) throw new Error(`No native name for locale ${locale}`);
  return name;
}

/**
 * Shown when the URL names no locale the Browser serves. It assumes no
 * language, so it has no translated text: each language is offered under its
 * own name, marked as that language.
 *
 * `path` is what follows the locale in the URL the reader is sent to.
 */
export function LanguagePicker({ path }: { path: string }) {
  return (
    <MainContent className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="px-4 py-12 text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-8">Semiont</h1>
        <ul className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 md:grid-cols-4">
          {AVAILABLE_LOCALES.map((locale) => (
            <li key={locale}>
              <Link
                to={`/${locale}${path}`}
                lang={locale}
                hrefLang={locale}
                className="text-lg text-blue-700 hover:underline dark:text-blue-300"
              >
                {nativeName(locale)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </MainContent>
  );
}
