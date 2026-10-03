/**
 * Tests for the interpolation pipeline every translation manager shares:
 * react-ui's built-in managers and the Browser's i18next-backed one.
 *
 * Two regression-guard suites:
 *
 * 1. Double-brace parameter substitution — covers the bug surfaced in the
 *    Settings panel where the manager used a single-brace regex
 *    (`\{paramKey\}`) against translations that use double braces
 *    (`{{paramKey}}`), producing artifacts like `Using {Light} mode`.
 *
 * 2. ICU plural format — covers the bug surfaced in the References panel
 *    where the manager didn't process plural syntax at all, rendering
 *    the literal `{count, plural, =0 {…} =1 {…} other {# categories
 *    selected}}` to the page.
 */

import { describe, it, expect } from 'vitest';
import {
  interpolateTranslation,
  processPluralFormat,
} from '../translation-interpolation';

describe('interpolateTranslation — double-brace parameter substitution', () => {
  it('replaces a single placeholder with the provided value', () => {
    expect(interpolateTranslation('Using {{mode}} mode', { mode: 'Light' }, 'en'))
      .toBe('Using Light mode');
  });

  it('replaces multiple placeholders with their respective values', () => {
    expect(
      interpolateTranslation('Hello {{first}} {{last}}', { first: 'Ada', last: 'Lovelace' }, 'en')
    ).toBe('Hello Ada Lovelace');
  });

  it('replaces every occurrence of the same placeholder (global match)', () => {
    expect(
      interpolateTranslation('{{x}} and {{x}} again', { x: 'hi' }, 'en')
    ).toBe('hi and hi again');
  });

  it('renders undefined values as the string "undefined" (not silent strip)', () => {
    // This is intentional: silent stripping would mask missing-prop bugs;
    // surfacing "undefined" makes them visible in development.
    expect(
      interpolateTranslation('Delay: {{delay}}ms', { delay: undefined }, 'en')
    ).toBe('Delay: undefinedms');
  });

  it('coerces numbers via String() in the substitution', () => {
    expect(
      interpolateTranslation('{{n}}ms delay', { n: 200 }, 'en')
    ).toBe('200ms delay');
  });

  it('does NOT match single-brace placeholders (regression guard for the original bug)', () => {
    // Translations standardize on double braces. If a template uses single
    // braces by mistake, the engine leaves them alone — fail loud rather
    // than silently re-interpret. The Settings-panel bug was the engine
    // matching a SUBSET of double braces with a single-brace regex; we
    // pin the opposite shape too: single-brace input is left untouched.
    expect(
      interpolateTranslation('Using {mode} mode', { mode: 'Light' }, 'en')
    ).toBe('Using {mode} mode');
  });

  it('leaves the string unchanged when no params match any placeholder', () => {
    expect(
      interpolateTranslation('Plain text with no placeholders', { unused: 'x' }, 'en')
    ).toBe('Plain text with no placeholders');
  });

  it('leaves a placeholder intact when the corresponding param is missing', () => {
    expect(
      interpolateTranslation('Using {{mode}} mode', {}, 'en')
    ).toBe('Using {{mode}} mode');
  });

  it('inserts a value holding `$` sequences as written', () => {
    // `String.prototype.replace` reads `$&`, `$$`, `` $` `` and `$'` in a
    // replacement string as patterns; a value is text, not a pattern.
    expect(interpolateTranslation('Name: {{n}}', { n: 'a$&b' }, 'en')).toBe('Name: a$&b');
    expect(interpolateTranslation('Price: {{p}} each', { p: '$$5' }, 'en')).toBe('Price: $$5 each');
    expect(interpolateTranslation('Before {{v}} after', { v: '$`' }, 'en')).toBe('Before $` after');
    expect(interpolateTranslation('Before {{v}} after', { v: "$'" }, 'en')).toBe("Before $' after");
  });

  it('inserts a count holding `$` sequences as written', () => {
    expect(interpolateTranslation('{count, plural, other {# items}}', { count: '$&' }, 'en'))
      .toBe('$& items');
  });
});

describe('processPluralFormat — ICU MessageFormat plural syntax', () => {
  // The exact template that surfaced the bug in the References (Tags)
  // panel — left in verbatim so a future reader can match it against
  // the screenshot if this regresses again.
  const TAG_COUNT_TEMPLATE =
    '{count, plural, =0 {No categories selected} =1 {1 category selected} other {# categories selected}}';

  it('selects the =0 case when count is 0', () => {
    expect(processPluralFormat(TAG_COUNT_TEMPLATE, { count: 0 }, 'en'))
      .toBe('No categories selected');
  });

  it('selects the =1 case when count is 1', () => {
    expect(processPluralFormat(TAG_COUNT_TEMPLATE, { count: 1 }, 'en'))
      .toBe('1 category selected');
  });

  it('selects the "other" case when count does not match any =N', () => {
    expect(processPluralFormat(TAG_COUNT_TEMPLATE, { count: 5 }, 'en'))
      .toBe('5 categories selected');
  });

  it('substitutes "#" inside the chosen branch with the count', () => {
    expect(processPluralFormat('{n, plural, other {# items}}', { n: 42 }, 'en'))
      .toBe('42 items');
  });

  it('leaves the template unchanged when the param is missing', () => {
    expect(
      processPluralFormat(TAG_COUNT_TEMPLATE, {}, 'en')
    ).toBe(TAG_COUNT_TEMPLATE);
  });

  it('leaves a non-plural template unchanged', () => {
    expect(
      processPluralFormat('{{mode}} mode', { mode: 'Light' }, 'en')
    ).toBe('{{mode}} mode');
  });

  it('handles plural format embedded in surrounding text', () => {
    const tpl = 'You have {n, plural, =0 {nothing} =1 {one item} other {# items}} today.';
    expect(processPluralFormat(tpl, { n: 0 }, 'en')).toBe('You have nothing today.');
    expect(processPluralFormat(tpl, { n: 1 }, 'en')).toBe('You have one item today.');
    expect(processPluralFormat(tpl, { n: 7 }, 'en')).toBe('You have 7 items today.');
  });

  it('handles a plural whose prefix is longer than its own `{name, plural, ` header', () => {
    // A scan that starts at the header's length instead of at the end of the
    // header lands before the opening brace once the prefix is this long, and
    // never finds the closing one.
    const tpl = 'The search finished and found {count, plural, =1 {# item} other {# items}} today.';
    expect(processPluralFormat(tpl, { count: 1 }, 'en')).toBe('The search finished and found 1 item today.');
    expect(processPluralFormat(tpl, { count: 7 }, 'en')).toBe('The search finished and found 7 items today.');
  });

  it('leaves an expression with no branch for the count as written', () => {
    const tpl = 'Found {count, plural, =1 {one item}}';
    expect(processPluralFormat(tpl, { count: 5 }, 'en')).toBe(tpl);
  });

  it('leaves an expression that never closes as written', () => {
    const tpl = 'Found {count, plural, =1 {# item} other {# items}';
    expect(processPluralFormat(tpl, { count: 5 }, 'en')).toBe(tpl);
  });
});

describe('processPluralFormat — plural categories', () => {
  const ITEMS = '{count, plural, one {# item} other {# items}}';
  const CATEGORY = '{count, plural, zero {ZERO} one {ONE} two {TWO} few {FEW} many {MANY} other {OTHER}}';

  it('selects a branch by the category the count falls in', () => {
    expect(processPluralFormat(ITEMS, { count: 1 }, 'en')).toBe('1 item');
    expect(processPluralFormat(ITEMS, { count: 0 }, 'en')).toBe('0 items');
    expect(processPluralFormat(ITEMS, { count: 2 }, 'en')).toBe('2 items');
  });

  it('prefers an exact =N branch to the category branch', () => {
    const tpl = '{count, plural, =1 {a single item} one {# item} other {# items}}';
    expect(processPluralFormat(tpl, { count: 1 }, 'en')).toBe('a single item');
  });

  it('takes the "other" branch when the category has none', () => {
    expect(processPluralFormat('{count, plural, few {# few} other {# items}}', { count: 1 }, 'en'))
      .toBe('1 items');
  });

  it('takes the "other" branch for a count that is not a number', () => {
    expect(processPluralFormat(ITEMS, { count: 'several' }, 'en')).toBe('several items');
  });

  it('decides the category by the rules of the language the string is in', () => {
    // English has two categories; Polish has four and Arabic six.
    expect(processPluralFormat(CATEGORY, { count: 3 }, 'en')).toBe('OTHER');
    expect(processPluralFormat(CATEGORY, { count: 3 }, 'pl')).toBe('FEW');
    expect(processPluralFormat(CATEGORY, { count: 5 }, 'pl')).toBe('MANY');
    expect(processPluralFormat(CATEGORY, { count: 0 }, 'ar')).toBe('ZERO');
    expect(processPluralFormat(CATEGORY, { count: 2 }, 'ar')).toBe('TWO');
  });

  it('pluralizes a Polish string', () => {
    const tpl = '{count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}';
    expect(processPluralFormat(tpl, { count: 1 }, 'pl')).toBe('1 plik');
    expect(processPluralFormat(tpl, { count: 3 }, 'pl')).toBe('3 pliki');
    expect(processPluralFormat(tpl, { count: 5 }, 'pl')).toBe('5 plików');
    expect(processPluralFormat(tpl, { count: 22 }, 'pl')).toBe('22 pliki');
  });
});

describe('processPluralFormat — several plurals in one string', () => {
  const tpl = '{files, plural, =1 {# file} other {# files}} in {folders, plural, =1 {# folder} other {# folders}}';

  it('resolves each of them', () => {
    expect(processPluralFormat(tpl, { files: 2, folders: 1 }, 'en')).toBe('2 files in 1 folder');
    expect(processPluralFormat(tpl, { files: 1, folders: 4 }, 'en')).toBe('1 file in 4 folders');
  });

  it('resolves the ones whose param is given and leaves the rest as written', () => {
    expect(processPluralFormat(tpl, { files: 2 }, 'en'))
      .toBe('2 files in {folders, plural, =1 {# folder} other {# folders}}');
    expect(processPluralFormat(tpl, { folders: 4 }, 'en'))
      .toBe('{files, plural, =1 {# file} other {# files}} in 4 folders');
  });
});

describe('processPluralFormat — braces inside a branch', () => {
  it('keeps a {{param}} placeholder in the chosen branch whole', () => {
    const tpl = '{n, plural, =1 {# item in {{scope}}} other {# items in {{scope}}}}';
    expect(processPluralFormat(tpl, { n: 1 }, 'en')).toBe('1 item in {{scope}}');
    expect(processPluralFormat(tpl, { n: 2 }, 'en')).toBe('2 items in {{scope}}');
  });

  it('resolves a plural nested in the chosen branch, each "#" taking its own count', () => {
    const tpl =
      '{files, plural, =0 {No files} other {# files in {folders, plural, =1 {# folder} other {# folders}}}}';
    expect(processPluralFormat(tpl, { files: 0, folders: 3 }, 'en')).toBe('No files');
    expect(processPluralFormat(tpl, { files: 2, folders: 1 }, 'en')).toBe('2 files in 1 folder');
    expect(processPluralFormat(tpl, { files: 2, folders: 3 }, 'en')).toBe('2 files in 3 folders');
  });
});

describe('interpolateTranslation — combining plural and double-brace syntaxes', () => {
  it('handles a plural followed by a {{paramKey}} substitution in the same string', () => {
    const tpl = '{n, plural, =1 {1 reload} other {# reloads}} pending in {{mode}} mode';
    expect(
      interpolateTranslation(tpl, { mode: 'Dark', n: 1 }, 'en')
    ).toBe('1 reload pending in Dark mode');
    expect(
      interpolateTranslation(tpl, { mode: 'Light', n: 3 }, 'en')
    ).toBe('3 reloads pending in Light mode');
  });

  it('substitutes a {{paramKey}} written inside a plural branch', () => {
    const tpl = '{n, plural, =1 {# item in {{scope}}} other {# items in {{scope}}}}';
    expect(interpolateTranslation(tpl, { n: 1, scope: 'Drafts' }, 'en')).toBe('1 item in Drafts');
    expect(interpolateTranslation(tpl, { n: 2, scope: 'Drafts' }, 'en')).toBe('2 items in Drafts');
  });

  it('runs both passes idempotently when one syntax is absent', () => {
    expect(
      interpolateTranslation('Plain {{x}}', { x: 'value' }, 'en')
    ).toBe('Plain value');
    expect(
      interpolateTranslation('{n, plural, other {# items}}', { n: 5 }, 'en')
    ).toBe('5 items');
  });
});
