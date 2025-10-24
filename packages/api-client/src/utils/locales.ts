/**
 * Locale information
 * Copied from SDK for frontend use
 */

export interface LocaleInfo {
  code: string;
  nativeName: string;
  englishName: string;
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'ar', nativeName: 'العربية', englishName: 'Arabic' },
  { code: 'bn', nativeName: 'বাংলা', englishName: 'Bengali' },
  { code: 'cs', nativeName: 'Čeština', englishName: 'Czech' },
  { code: 'da', nativeName: 'Dansk', englishName: 'Danish' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German' },
  { code: 'el', nativeName: 'Ελληνικά', englishName: 'Greek' },
  { code: 'en', nativeName: 'English', englishName: 'English' },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish' },
  { code: 'fa', nativeName: 'فارسی', englishName: 'Persian' },
  { code: 'fi', nativeName: 'Suomi', englishName: 'Finnish' },
  { code: 'fr', nativeName: 'Français', englishName: 'French' },
  { code: 'he', nativeName: 'עברית', englishName: 'Hebrew' },
  { code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi' },
  { code: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian' },
  { code: 'it', nativeName: 'Italiano', englishName: 'Italian' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese' },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean' },
  { code: 'ms', nativeName: 'Bahasa Melayu', englishName: 'Malay' },
  { code: 'nl', nativeName: 'Nederlands', englishName: 'Dutch' },
  { code: 'no', nativeName: 'Norsk', englishName: 'Norwegian' },
  { code: 'pl', nativeName: 'Polski', englishName: 'Polish' },
  { code: 'pt', nativeName: 'Português', englishName: 'Portuguese' },
  { code: 'ro', nativeName: 'Română', englishName: 'Romanian' },
  { code: 'sv', nativeName: 'Svenska', englishName: 'Swedish' },
  { code: 'th', nativeName: 'ไทย', englishName: 'Thai' },
  { code: 'tr', nativeName: 'Türkçe', englishName: 'Turkish' },
  { code: 'uk', nativeName: 'Українська', englishName: 'Ukrainian' },
  { code: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese' },
  { code: 'zh', nativeName: '中文', englishName: 'Chinese' },
] as const;

/**
 * Format locale code for display (shows native name and English name)
 */
export function formatLocaleDisplay(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }

  const locale = LOCALES.find(l => l.code === code);
  if (!locale) {
    return code;
  }

  return `${locale.nativeName} (${locale.englishName})`;
}
