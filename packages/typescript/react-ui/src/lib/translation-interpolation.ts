/** Index of the `}` closing a `{` opened before `from`, or -1 when it never closes. */
function closingBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The branches of a plural's body, `=0 {…} one {…} other {…}`, by selector. */
function pluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  const selector = /\s*(=\d+|\w+)\s*\{/y;
  let match;
  while ((match = selector.exec(body)) !== null) {
    const end = closingBrace(body, selector.lastIndex);
    if (end === -1) break;
    branches.set(match[1], body.slice(selector.lastIndex, end));
    selector.lastIndex = end + 1;
  }
  return branches;
}

function selectBranch(
  branches: Map<string, string>,
  count: unknown,
  locale: string,
): string | undefined {
  return branches.get(`=${count}`)
    ?? branches.get(new Intl.PluralRules(locale).select(Number(count)))
    ?? branches.get('other');
}

/**
 * Walk a template once, replacing what it names: a plural expression with its
 * chosen branch, a `{{param}}` placeholder with the param's value and, in the
 * branch of a plural, `#` with that plural's count. Only a template is walked,
 * the chosen branch included; a value goes in as written.
 */
function interpolate(
  template: string,
  params: Record<string, unknown>,
  locale: string,
  count: string | undefined,
): string {
  const named = /\{(\w+),\s*plural,\s*|\{\{([^{}]+)\}\}|#/g;
  let result = '';
  let copiedTo = 0;
  let match;
  while ((match = named.exec(template)) !== null) {
    const [, pluralParam, placeholderParam] = match;
    let value: string | undefined;

    if (pluralParam !== undefined) {
      const end = closingBrace(template, named.lastIndex);
      if (end === -1) break;
      const pluralCount = params[pluralParam];
      const branch = pluralCount === undefined
        ? undefined
        : selectBranch(pluralBranches(template.slice(named.lastIndex, end)), pluralCount, locale);
      if (branch !== undefined) value = interpolate(branch, params, locale, String(pluralCount));
      named.lastIndex = end + 1;
    } else if (placeholderParam !== undefined) {
      if (Object.hasOwn(params, placeholderParam)) value = String(params[placeholderParam]);
    } else {
      value = count;
    }

    if (value !== undefined) {
      result += template.slice(copiedTo, match.index) + value;
      copiedTo = named.lastIndex;
    }
  }
  return result + template.slice(copiedTo);
}

/**
 * The interpolation every translation string goes through.
 *
 * - `{count, plural, =0 {text} one {text} other {text}}` becomes one of its
 *   branches: the exact match (`=N`) first, then the plural category the count
 *   falls in (`zero`, `one`, `two`, `few`, `many`), then `other`. `locale` is
 *   the language the string is written in; its rules decide the category.
 *   `#` in a branch stands for the count, and a branch may hold placeholders
 *   and further plural expressions.
 * - `{{paramKey}}` becomes the param's value.
 *
 * What cannot be resolved is left as written: a placeholder or plural whose
 * param is missing, a plural with no branch for the count, and a plural that
 * never closes together with what follows it.
 */
export function interpolateTranslation(
  translation: string,
  params: Record<string, unknown>,
  locale: string,
): string {
  return interpolate(translation, params, locale, undefined);
}
