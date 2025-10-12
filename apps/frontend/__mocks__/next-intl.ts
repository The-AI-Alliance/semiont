import { vi } from 'vitest';

// Mock translation function that returns the key and handles parameters
const mockTranslations = (key: string, params?: Record<string, any>) => {
  // Return the key itself for simple cases
  if (!params) return key;

  // Handle parameterized translations (like {date})
  let result = key;
  Object.entries(params).forEach(([paramKey, paramValue]) => {
    result = result.replace(`{${paramKey}}`, String(paramValue));
  });
  return result;
};

export const useTranslations = vi.fn(() => mockTranslations);
export const useLocale = vi.fn(() => 'en');
export const NextIntlClientProvider = ({ children }: any) => children;
export const useMessages = vi.fn(() => ({}));
