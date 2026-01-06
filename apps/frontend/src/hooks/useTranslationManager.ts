import { useMemo } from 'react';
import { useMessages } from 'next-intl';
import type { TranslationManager } from '@semiont/react-ui';

/**
 * Frontend implementation of TranslationManager
 * Wraps next-intl's useMessages to provide TranslationManager interface
 */
export function useTranslationManager(): TranslationManager {
  const messages = useMessages();

  return useMemo(
    () => ({
      t: (namespace: string, key: string): string => {
        const typedMessages = messages as Record<string, Record<string, string>>;
        const namespaceMessages = typedMessages[namespace];
        return namespaceMessages?.[key] || key;
      },
    }),
    [messages]
  );
}
