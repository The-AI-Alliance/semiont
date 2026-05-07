/**
 * Tests for the frontend's `useMergedTranslationManager` interpolation
 * pipeline. The hook itself is a thin react-i18next wrapper; the
 * interesting logic is the pure `interpolateTranslation` and
 * `processPluralFormat` functions, which are exported for unit testing.
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
 *
 * The two managers (this one and the reference in
 * `@semiont/react-ui/contexts/TranslationContext`) are kept in sync;
 * these tests pin the contract so they don't drift again.
 */

import { describe, it, expect } from 'vitest';
import {
  interpolateTranslation,
  processPluralFormat,
} from '../useMergedTranslationManager';

describe('interpolateTranslation — double-brace parameter substitution', () => {
  it('replaces a single placeholder with the provided value', () => {
    expect(interpolateTranslation('Using {{mode}} mode', { mode: 'Light' }))
      .toBe('Using Light mode');
  });

  it('replaces multiple placeholders with their respective values', () => {
    expect(
      interpolateTranslation('Hello {{first}} {{last}}', { first: 'Ada', last: 'Lovelace' })
    ).toBe('Hello Ada Lovelace');
  });

  it('replaces every occurrence of the same placeholder (global match)', () => {
    expect(
      interpolateTranslation('{{x}} and {{x}} again', { x: 'hi' })
    ).toBe('hi and hi again');
  });

  it('renders undefined values as the string "undefined" (not silent strip)', () => {
    // This is intentional: silent stripping would mask missing-prop bugs;
    // surfacing "undefined" makes them visible in development.
    expect(
      interpolateTranslation('Delay: {{delay}}ms', { delay: undefined })
    ).toBe('Delay: undefinedms');
  });

  it('coerces numbers via String() in the substitution', () => {
    expect(
      interpolateTranslation('{{n}}ms delay', { n: 200 })
    ).toBe('200ms delay');
  });

  it('does NOT match single-brace placeholders (regression guard for the original bug)', () => {
    // Translations standardize on double braces. If a template uses single
    // braces by mistake, the engine leaves them alone — fail loud rather
    // than silently re-interpret. The Settings-panel bug was the engine
    // matching a SUBSET of double braces with a single-brace regex; we
    // pin the opposite shape too: single-brace input is left untouched.
    expect(
      interpolateTranslation('Using {mode} mode', { mode: 'Light' })
    ).toBe('Using {mode} mode');
  });

  it('leaves the string unchanged when no params match any placeholder', () => {
    expect(
      interpolateTranslation('Plain text with no placeholders', { unused: 'x' })
    ).toBe('Plain text with no placeholders');
  });

  it('leaves a placeholder intact when the corresponding param is missing', () => {
    expect(
      interpolateTranslation('Using {{mode}} mode', {})
    ).toBe('Using {{mode}} mode');
  });
});

describe('processPluralFormat — ICU MessageFormat plural syntax', () => {
  // The exact template that surfaced the bug in the References (Tags)
  // panel — left in verbatim so a future reader can match it against
  // the screenshot if this regresses again.
  const TAG_COUNT_TEMPLATE =
    '{count, plural, =0 {No categories selected} =1 {1 category selected} other {# categories selected}}';

  it('selects the =0 case when count is 0', () => {
    expect(processPluralFormat(TAG_COUNT_TEMPLATE, { count: 0 }))
      .toBe('No categories selected');
  });

  it('selects the =1 case when count is 1', () => {
    expect(processPluralFormat(TAG_COUNT_TEMPLATE, { count: 1 }))
      .toBe('1 category selected');
  });

  it('selects the "other" case when count does not match any =N', () => {
    expect(processPluralFormat(TAG_COUNT_TEMPLATE, { count: 5 }))
      .toBe('5 categories selected');
  });

  it('substitutes "#" inside the chosen branch with the count', () => {
    expect(processPluralFormat('{n, plural, other {# items}}', { n: 42 }))
      .toBe('42 items');
  });

  it('leaves the template unchanged when the param is missing', () => {
    expect(
      processPluralFormat(TAG_COUNT_TEMPLATE, {})
    ).toBe(TAG_COUNT_TEMPLATE);
  });

  it('leaves a non-plural template unchanged', () => {
    expect(
      processPluralFormat('{{mode}} mode', { mode: 'Light' })
    ).toBe('{{mode}} mode');
  });

  it('handles plural format embedded in surrounding text', () => {
    const tpl = 'You have {n, plural, =0 {nothing} =1 {one item} other {# items}} today.';
    expect(processPluralFormat(tpl, { n: 0 })).toBe('You have nothing today.');
    expect(processPluralFormat(tpl, { n: 1 })).toBe('You have one item today.');
    expect(processPluralFormat(tpl, { n: 7 })).toBe('You have 7 items today.');
  });
});

describe('interpolateTranslation — combining plural and double-brace syntaxes', () => {
  it('handles a plural followed by a {{paramKey}} substitution in the same string', () => {
    // Mirrors the shape of a realistic translation: pluralized count
    // alongside a separate parameter. The plural branch parser uses
    // `[^}]+` per branch, so `{{...}}` cannot be nested INSIDE a plural
    // branch — but adjacent plural and double-brace forms work fine.
    const tpl = '{n, plural, =1 {1 reload} other {# reloads}} pending in {{mode}} mode';
    expect(
      interpolateTranslation(tpl, { mode: 'Dark', n: 1 })
    ).toBe('1 reload pending in Dark mode');
    expect(
      interpolateTranslation(tpl, { mode: 'Light', n: 3 })
    ).toBe('3 reloads pending in Light mode');
  });

  it('runs both passes idempotently when one syntax is absent', () => {
    expect(
      interpolateTranslation('Plain {{x}}', { x: 'value' })
    ).toBe('Plain value');
    expect(
      interpolateTranslation('{n, plural, other {# items}}', { n: 5 })
    ).toBe('5 items');
  });
});
