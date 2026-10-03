/**
 * The languages Semiont supports, and lookups over them. The table is
 * generated from specs/src/locales/registry.json.
 */

import { LOCALES, type LocaleInfo } from './generated/locales';

export { LOCALES, LOCALE_CODES } from './generated/locales';
export type { LocaleCode, LocaleInfo } from './generated/locales';

// Create lookup map for efficient access
const localeByCode = new Map<string, LocaleInfo>(
  LOCALES.map(locale => [locale.code.toLowerCase(), locale])
);

/**
 * Get locale information by code
 */
export function getLocaleInfo(code: string | undefined): LocaleInfo | undefined {
  if (!code) return undefined;
  return localeByCode.get(code.toLowerCase());
}

/**
 * Get the native name of a language by its locale code
 */
export function getLocaleNativeName(code: string | undefined): string | undefined {
  return getLocaleInfo(code)?.nativeName;
}

/**
 * Get the English name of a language by its locale code
 */
export function getLocaleEnglishName(code: string | undefined): string | undefined {
  return getLocaleInfo(code)?.englishName;
}

/**
 * Format locale code for display as "Native Name (code)"
 */
export function formatLocaleDisplay(code: string | undefined): string | undefined {
  if (!code) return undefined;

  const info = getLocaleInfo(code);
  if (!info) return code;

  return `${info.nativeName} (${code.toLowerCase()})`;
}
