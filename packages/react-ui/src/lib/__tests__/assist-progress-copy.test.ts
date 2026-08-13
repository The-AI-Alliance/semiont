/**
 * The one wire→copy mapping (ASSIST-PROGRESS-CONSOLIDATION P3).
 *
 * Two things are pinned here, and the second is the interesting one.
 *
 * 1. Every code names the key it should.
 * 2. **Every key it names actually EXISTS in `en.json`.** This closes a gap
 *    neither existing guard can see. `assistProgressCopy`'s switch is
 *    exhaustive with a `never` default, so a code with no `case` fails to
 *    compile — but nothing checks that the string inside the case is a real
 *    key. And `lint:translations` compares locales against `en`, so a key
 *    missing from `en` *too* is missing everywhere and the gate stays green.
 *    A typo'd key ships the key name to the user, in every language.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '@semiont/core';
import { assistProgressCopy, assistSubjectCopy, assistParamLabel } from '../assist-progress-copy';
import en from '../../../translations/en.json';

type JobProgressMessage = components['schemas']['JobProgressMessage'];

/** Records the key + params each call asks for, instead of translating. */
const spy = () => {
  const calls: Array<{ key: string; params?: Record<string, unknown> }> = [];
  const t = (key: string, params?: Record<string, unknown>) => {
    calls.push(params ? { key, params } : { key });
    return key;
  };
  return { t, calls };
};

const NAMESPACE = (en as Record<string, Record<string, string>>).AssistProgress;

/** Every member of the union, one per variant shape. */
const ALL: Array<{ message: JobProgressMessage; key: string }> = [
  { message: { code: 'loading' }, key: 'codeLoading' },
  { message: { code: 'analyzing' }, key: 'codeAnalyzing' },
  { message: { code: 'analyzing-tags' }, key: 'codeAnalyzingTags' },
  { message: { code: 'generating-resource' }, key: 'codeGeneratingResource' },
  { message: { code: 'creating-resource' }, key: 'codeCreatingResource' },
  { message: { code: 'detecting-entities', entityType: 'Person' }, key: 'codeDetectingEntities' },
  { message: { code: 'creating-annotations', count: 3 }, key: 'codeCreatingAnnotations' },
  { message: { code: 'creating-tag-annotations', count: 4 }, key: 'codeCreatingTagAnnotations' },
  {
    message: { code: 'complete-created', count: 7, kind: 'reference' },
    key: 'codeCompleteCreated',
  },
];

describe('assistProgressCopy', () => {
  it.each(ALL)('maps $message.code to its key', ({ message, key }) => {
    const { t, calls } = spy();
    assistProgressCopy(t)(message);
    expect(calls.map((c) => c.key)).toContain(key);
  });

  it('every key it can name exists in en.json', () => {
    const { t, calls } = spy();
    const copy = assistProgressCopy(t);
    for (const { message } of ALL) copy(message);

    const missing = [...new Set(calls.map((c) => c.key))].filter((k) => !(k in NAMESPACE));
    expect(missing).toEqual([]);
  });

  it('passes count through for the counted codes', () => {
    const { t, calls } = spy();
    assistProgressCopy(t)({ code: 'creating-annotations', count: 12 });
    expect(calls[0]?.params).toMatchObject({ count: 12 });
  });

  it('translates the annotation KIND too — "7 references" is two translated parts', () => {
    const kinds = ['highlight', 'comment', 'assessment', 'reference', 'tag'] as const;
    for (const kind of kinds) {
      const { t, calls } = spy();
      assistProgressCopy(t)({ code: 'complete-created', count: 1, kind });
      const expected = `kind${kind[0]!.toUpperCase()}${kind.slice(1)}`;
      expect(calls.map((c) => c.key)).toContain(expected);
      expect(expected in NAMESPACE).toBe(true);
    }
  });

  it('does not leak the raw code into the copy', () => {
    // The code is a wire token. If it ever reached the string the user reads,
    // that is the untranslated leak this whole arc removed.
    const { t } = spy();
    const out = assistProgressCopy(t)({ code: 'detecting-entities', entityType: 'Person' });
    expect(out).not.toContain('detecting-entities');
  });
});

describe('assistSubjectCopy', () => {
  it('uses the positionless form when there is no fraction', () => {
    const { t, calls } = spy();
    assistSubjectCopy(t)('Person');
    expect(calls[0]?.key).toBe('subject');
    expect(calls[0]?.params).toMatchObject({ label: 'Person' });
    expect('subject' in NAMESPACE).toBe(true);
  });

  it('uses the positioned form and counts from ONE, not zero', () => {
    // `processedEntityTypes` is a zero-based count of COMPLETED types, so the
    // type in flight is index+1. Rendering "0 of 3" while working on the first
    // would read as not-started.
    const { t, calls } = spy();
    assistSubjectCopy(t)('Person', 0, 3);
    expect(calls[0]?.key).toBe('subjectWithPosition');
    expect(calls[0]?.params).toMatchObject({ label: 'Person', done: 1, total: 3 });
    expect('subjectWithPosition' in NAMESPACE).toBe(true);
  });

  it('falls back to the positionless form when either number is absent', () => {
    const { t, calls } = spy();
    assistSubjectCopy(t)('Person', 2, undefined);
    expect(calls[0]?.key).toBe('subject');
  });
});

describe('assistParamLabel', () => {
  /** Every label code the schema's enum permits. */
  const CODES = ['entity-types', 'instructions', 'tone', 'density'] as const;

  it.each(CODES)('names a real en.json key for %s', (code) => {
    const { t, calls } = spy();
    assistParamLabel(t)(code);
    const key = calls[0]?.key;
    expect(key).toBeDefined();
    expect(key! in NAMESPACE).toBe(true);
  });

  it('never renders the wire code itself for a known label', () => {
    // The codes are wire tokens — kebab-case and English. A user reading a
    // Japanese UI must never see "entity-types".
    const { t } = spy();
    for (const code of CODES) expect(assistParamLabel(t)(code)).not.toBe(code);
  });

  it('falls back to the code for an unknown label rather than rendering nothing', () => {
    const { t } = spy();
    expect(assistParamLabel(t)('future-param')).toBe('future-param');
  });
});
