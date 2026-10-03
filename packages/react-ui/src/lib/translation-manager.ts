import type { TranslationManager } from '../types/TranslationManager';
import { interpolateTranslation } from './translation-interpolation';

/** One locale's translations: namespace, then key. */
export type Messages = Record<string, Record<string, string>>;

/** The manager for one locale's messages. `locale` is the language they are written in. */
export function createTranslationManager(locale: string, messages: Messages): TranslationManager {
  return {
    t: (namespace: string, key: string, params?: Record<string, any>) => {
      const translation = messages[namespace]?.[key];

      if (!translation) {
        console.warn(`Translation not found for ${namespace}.${key} in locale ${locale}`);
        return `${namespace}.${key}`;
      }

      if (params && typeof translation === 'string') {
        return interpolateTranslation(translation, params, locale);
      }

      return translation;
    },
  };
}
