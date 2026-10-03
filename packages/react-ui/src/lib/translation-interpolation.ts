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
 * Resolve every ICU MessageFormat plural expression in a string:
 * `{count, plural, =0 {text} one {text} other {text}}`.
 *
 * A branch is chosen by exact match (`=N`) first, then by the plural category
 * the count falls in under `locale`'s rules (`zero`, `one`, `two`, `few`,
 * `many`), then `other`. `#` in a branch stands for the count. A branch may
 * hold `{{param}}` placeholders and further plural expressions. An expression
 * whose param is missing, or that has no branch for the count, is left as
 * written.
 */
export function processPluralFormat(
  text: string,
  params: Record<string, unknown>,
  locale: string,
): string {
  const header = /\{(\w+),\s*plural,\s*/g;
  let resolved = '';
  let unresolvedFrom = 0;
  let match;
  while ((match = header.exec(text)) !== null) {
    const end = closingBrace(text, header.lastIndex);
    if (end === -1) break;

    const count = params[match[1]];
    const branch = count === undefined
      ? undefined
      : selectBranch(pluralBranches(text.slice(header.lastIndex, end)), count, locale);
    if (branch !== undefined) {
      // A nested plural resolves first, so the `#`s left are this plural's own.
      resolved += text.slice(unresolvedFrom, match.index)
        + processPluralFormat(branch, params, locale).replace(/#/g, () => String(count));
      unresolvedFrom = end + 1;
    }
    header.lastIndex = end + 1;
  }
  return resolved + text.slice(unresolvedFrom);
}

/**
 * The interpolation every translation string goes through: plural format
 * first (since it may consume more of the string), then `{{paramKey}}`
 * parameter substitution. `locale` is the language the string is written in;
 * its plural rules decide which branch a count takes.
 *
 * Placeholders are replaced in one pass over the string, not one param at a
 * time, so a value inserted for one placeholder is not scanned for another.
 */
export function interpolateTranslation(
  translation: string,
  params: Record<string, unknown>,
  locale: string,
): string {
  return processPluralFormat(translation, params, locale).replace(
    /\{\{([^{}]+)\}\}/g,
    (placeholder, paramKey: string) =>
      Object.hasOwn(params, paramKey) ? String(params[paramKey]) : placeholder,
  );
}
