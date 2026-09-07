/**
 * Locale information
 * Copied from SDK for frontend use
 */
export interface LocaleInfo {
    code: string;
    nativeName: string;
    englishName: string;
}
export declare const LOCALES: readonly LocaleInfo[];
/**
 * Get locale information by code
 */
export declare function getLocaleInfo(code: string | undefined): LocaleInfo | undefined;
/**
 * Get the native name of a language by its locale code
 */
export declare function getLocaleNativeName(code: string | undefined): string | undefined;
/**
 * Get the English name of a language by its locale code
 */
export declare function getLocaleEnglishName(code: string | undefined): string | undefined;
/**
 * Format locale code for display as "Native Name (code)"
 */
export declare function formatLocaleDisplay(code: string | undefined): string | undefined;
/**
 * Get all supported locale codes
 */
export declare function getAllLocaleCodes(): readonly string[];
