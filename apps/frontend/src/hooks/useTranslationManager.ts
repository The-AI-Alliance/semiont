import { useMemo } from 'react';
import { useLocale } from 'next-intl';
import type { TranslationManager } from '@semiont/react-ui';

// Import all message files
import ar from '@/messages/ar.json';
import bn from '@/messages/bn.json';
import cs from '@/messages/cs.json';
import da from '@/messages/da.json';
import de from '@/messages/de.json';
import el from '@/messages/el.json';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import fa from '@/messages/fa.json';
import fi from '@/messages/fi.json';
import fr from '@/messages/fr.json';
import he from '@/messages/he.json';
import hi from '@/messages/hi.json';
import id from '@/messages/id.json';
import it from '@/messages/it.json';
import ja from '@/messages/ja.json';
import ko from '@/messages/ko.json';
import ms from '@/messages/ms.json';
import nl from '@/messages/nl.json';
import no from '@/messages/no.json';
import pl from '@/messages/pl.json';
import pt from '@/messages/pt.json';
import ro from '@/messages/ro.json';
import sv from '@/messages/sv.json';
import th from '@/messages/th.json';
import tr from '@/messages/tr.json';
import uk from '@/messages/uk.json';
import vi from '@/messages/vi.json';
import zh from '@/messages/zh.json';

// Map of locale codes to message objects
const messages: Record<string, Record<string, Record<string, string>>> = {
  ar,
  bn,
  cs,
  da,
  de,
  el,
  en,
  es,
  fa,
  fi,
  fr,
  he,
  hi,
  id,
  it,
  ja,
  ko,
  ms,
  nl,
  no,
  pl,
  pt,
  ro,
  sv,
  th,
  tr,
  uk,
  vi,
  zh,
};

/**
 * Frontend implementation of TranslationManager
 * Uses next-intl message files but loads them directly without using next-intl hooks
 */
export function useTranslationManager(): TranslationManager {
  const locale = useLocale();

  return useMemo(
    () => ({
      t: (namespace: string, key: string): string => {
        const localeMessages = messages[locale] || messages.en;
        const namespaceMessages = localeMessages[namespace];
        return namespaceMessages?.[key] || key;
      },
    }),
    [locale]
  );
}
