import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TranslationManager } from '@semiont/react-ui';

type Messages = Record<string, Record<string, string>>;

/**
 * Process ICU MessageFormat plural syntax.
 * Supports: `{count, plural, =0 {text} =1 {text} other {text}}` with `#` as
 * the count placeholder inside each branch.
 *
 * Mirrors the reference implementation in
 * `packages/react-ui/src/contexts/TranslationContext.tsx`. Kept in sync
 * deliberately — diverging the two managers is what produced the
 * literal-plural-format render bug in the Tags panel.
 */
export function processPluralFormat(text: string, params: Record<string, unknown>): string {
  const pluralMatch = text.match(/\{(\w+),\s*plural,\s*/);
  if (!pluralMatch) return text;

  const paramName = pluralMatch[1]!;
  const count = params[paramName];
  if (count === undefined) return text;

  // Find the matching closing brace by counting nested pairs.
  const startPos = pluralMatch[0].length + pluralMatch.index!;
  let braceCount = 1;
  let endPos = startPos;
  for (let i = startPos; i < text.length; i++) {
    if (text[i] === '{') braceCount++;
    else if (text[i] === '}') {
      braceCount--;
      if (braceCount === 0) { endPos = i; break; }
    }
  }

  const pluralCases = text.substring(startPos, endPos);
  const cases: Record<string, string> = {};
  const caseRegex = /(?:=(\d+)|(\w+))\s*\{([^}]+)\}/g;
  let caseMatch;
  while ((caseMatch = caseRegex.exec(pluralCases)) !== null) {
    const [, exactNumber, keyword, textContent] = caseMatch;
    const key = exactNumber !== undefined ? `=${exactNumber}` : keyword!;
    cases[key] = textContent!;
  }

  const exactMatch = cases[`=${count}`];
  if (exactMatch !== undefined) {
    const replaced = exactMatch.replace(/#/g, String(count));
    return text.substring(0, pluralMatch.index!) + replaced + text.substring(endPos + 1);
  }
  const otherCase = cases['other'];
  if (otherCase !== undefined) {
    const replaced = otherCase.replace(/#/g, String(count));
    return text.substring(0, pluralMatch.index!) + replaced + text.substring(endPos + 1);
  }
  return text;
}

/**
 * Run a translation string through the standard interpolation pipeline:
 * plural format first (since it may consume more of the string), then
 * `{{paramKey}}` parameter substitution. Exported for unit testing.
 */
export function interpolateTranslation(
  translation: string,
  params: Record<string, unknown>,
): string {
  let result = processPluralFormat(translation, params);
  Object.entries(params).forEach(([paramKey, paramValue]) => {
    result = result.replace(new RegExp(`\\{\\{${paramKey}\\}\\}`, 'g'), String(paramValue));
  });
  return result;
}

/**
 * Translation Manager for Frontend
 *
 * Wraps react-i18next. The messages JSON (loaded by i18next-http-backend) has
 * the same flat namespace structure: { "Namespace": { "key": "value" } }.
 * TranslationManager.t(namespace, key) maps directly to this structure.
 *
 * Interpolation supports two syntaxes, in this precedence order:
 *
 * 1. ICU MessageFormat plural — `{count, plural, =0 {…} =1 {…} other {…}}`
 *    — used for count-sensitive strings like "1 category selected" /
 *    "3 categories selected".
 * 2. Double-brace parameter substitution — `{{paramKey}}` — used for
 *    everything else (`{{mode}}`, `{{delay}}`, etc.).
 *
 * The two managers (this one and the reference in
 * `@semiont/react-ui/contexts/TranslationContext`) implement the same
 * interpolation contract; keep them aligned when changing either.
 */
export function useMergedTranslationManager(): TranslationManager {
  const { i18n } = useTranslation();

  return useMemo(() => {
    return {
      t: (namespace: string, key: string, params?: Record<string, unknown>): string => {
        const messages = i18n.getResourceBundle(i18n.language, 'translation') as Messages | undefined;
        const translation = messages?.[namespace]?.[key];

        if (!translation) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`Translation not found: ${namespace}.${key} (locale: ${i18n.language})`);
          }
          return `${namespace}.${key}`;
        }

        if (params && typeof translation === 'string') {
          return interpolateTranslation(translation, params);
        }

        return translation;
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n, i18n.language]);
}
