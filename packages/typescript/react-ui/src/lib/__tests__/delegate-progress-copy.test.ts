/**
 * The one wire→copy mapping: each progress code to its localized text.
 *
 * Two things are pinned here, and the second is the interesting one.
 *
 * 1. Every code names the key it should.
 * 2. **Every key it names actually EXISTS in `en.json`.** This closes a gap
 *    neither existing guard can see. `delegateProgressCopy`'s switch is
 *    exhaustive with a `never` default, so a code with no `case` fails to
 *    compile — but nothing checks that the string inside the case is a real
 *    key. And `lint:translations` compares locales against `en`, so a key
 *    missing from `en` *too* is missing everywhere and the gate stays green.
 *    A typo'd key ships the key name to the user, in every language.
 */
import { describe, it, expect } from 'vitest';
import { MARK_MOTIVATIONS, type components } from '@semiont/core';
import { delegateProgressCopy, delegateSubjectCopy, delegateParamLabel } from '../delegate-progress-copy';
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

const NAMESPACE = (en as Record<string, Record<string, string>>).DelegateProgress;

/** Every member of the union, one per variant shape. */
const ALL: Array<{ message: JobProgressMessage; key: string }> = [
  { message: { code: 'loading' }, key: 'codeLoading' },
  { message: { code: 'analyzing' }, key: 'codeAnalyzing' },
  { message: { code: 'analyzing-tags' }, key: 'codeAnalyzingTags' },
  { message: { code: 'generating-resource' }, key: 'codeGeneratingResource' },
  { message: { code: 'creating-resource' }, key: 'codeCreatingResource' },
  { message: { code: 'complete-generated', truncated: false }, key: 'codeCompleteGenerated' },
  // A run cut off at the maxTokens ceiling completes, but never silently.
  { message: { code: 'complete-generated', truncated: true }, key: 'codeCompleteGeneratedTruncated' },
  { message: { code: 'detecting-entities', entityType: 'Person' }, key: 'codeDetectingEntities' },
  { message: { code: 'creating-annotations', count: 3 }, key: 'codeCreatingAnnotations' },
  { message: { code: 'creating-tag-annotations', count: 4 }, key: 'codeCreatingTagAnnotations' },
  {
    message: { code: 'complete-created', count: 7, motivation: 'linking' },
    key: 'codeCompleteCreated',
  },
];

describe('delegateProgressCopy', () => {
  it.each(ALL)('maps $message.code to its key', ({ message, key }) => {
    const { t, calls } = spy();
    delegateProgressCopy(t)(message);
    expect(calls.map((c) => c.key)).toContain(key);
  });

  it('every key it can name exists in en.json', () => {
    const { t, calls } = spy();
    const copy = delegateProgressCopy(t);
    for (const { message } of ALL) copy(message);

    const missing = [...new Set(calls.map((c) => c.key))].filter((k) => !(k in NAMESPACE));
    expect(missing).toEqual([]);
  });

  it('passes count through for the counted codes', () => {
    const { t, calls } = spy();
    delegateProgressCopy(t)({ code: 'creating-annotations', count: 12 });
    expect(calls[0]?.params).toMatchObject({ count: 12 });
  });

  it('words what was created from the job\'s motivation — "7 references" is two translated parts', () => {
    const { t, calls } = spy();
    delegateProgressCopy(t)({ code: 'complete-created', count: 7, motivation: 'linking' });
    // The spy echoes the key, so the noun handed to the sentence is the noun's key.
    expect(calls).toEqual([
      { key: 'nounLinking' },
      { key: 'codeCompleteCreated', params: { count: 7, noun: 'nounLinking' } },
    ]);
    expect(NAMESPACE.nounLinking).toBe('references');
  });

  it('en.json holds one noun for every motivation a mark job has, and no other', () => {
    // The motivations are the spec's (MARK_MOTIVATIONS is generated from it).
    // A noun left behind by a motivation that is gone is copy nobody reads.
    const named = MARK_MOTIVATIONS.map((motivation) => {
      const { t, calls } = spy();
      delegateProgressCopy(t)({ code: 'complete-created', count: 1, motivation });
      return calls[0]!.key;
    });
    const held = Object.keys(NAMESPACE).filter((key) => key.startsWith('noun'));
    expect([...named].sort()).toEqual([...held].sort());
    expect(new Set(named).size).toBe(MARK_MOTIVATIONS.length);
  });

  it('does not leak the raw code into the copy', () => {
    // The code is a wire token. If it ever reached the string the user reads,
    // that is the untranslated leak this whole arc removed.
    const { t } = spy();
    const out = delegateProgressCopy(t)({ code: 'detecting-entities', entityType: 'Person' });
    expect(out).not.toContain('detecting-entities');
  });
});

describe('delegateSubjectCopy', () => {
  const ENTITY_TYPE = { kind: 'entity-type', value: 'Person' } as const;
  const CATEGORY = { kind: 'category', value: 'Issue' } as const;

  it('uses the positionless form when there is no fraction', () => {
    const { t, calls } = spy();
    delegateSubjectCopy(t)(ENTITY_TYPE);
    expect(calls.map((c) => c.key)).toContain('subject');
    expect(calls.at(-1)?.params).toMatchObject({ label: 'Person' });
    expect('subject' in NAMESPACE).toBe(true);
  });

  it('uses the positioned form and counts from ONE, not zero', () => {
    // `processed` is a zero-based count of COMPLETED items, so the one in
    // flight is index+1. Rendering "0 of 3" while working on the first would
    // read as not-started.
    const { t, calls } = spy();
    delegateSubjectCopy(t)(ENTITY_TYPE, 0, 3);
    expect(calls.map((c) => c.key)).toContain('subjectWithPosition');
    expect(calls.at(-1)?.params).toMatchObject({ label: 'Person', done: 1, total: 3 });
    expect('subjectWithPosition' in NAMESPACE).toBe(true);
  });

  it('falls back to the positionless form when either number is absent', () => {
    const { t, calls } = spy();
    delegateSubjectCopy(t)(ENTITY_TYPE, 2, undefined);
    expect(calls.map((c) => c.key)).toContain('subject');
  });

  it('localizes the KIND and never leaks the wire code', () => {
    // "Person" is an entity type and the line should say so — but "entity-type"
    // is a wire token, and a user reading a Japanese UI must never see it.
    for (const [current, key] of [
      [ENTITY_TYPE, 'subjectKindEntityType'],
      [CATEGORY, 'subjectKindCategory'],
    ] as const) {
      const { t, calls } = spy();
      delegateSubjectCopy(t)(current, 0, 2);
      expect(calls.map((c) => c.key)).toContain(key);
      expect(key in NAMESPACE).toBe(true);
      expect(calls.at(-1)?.params?.kind).toBe(key);   // the spy echoes the key
      expect(calls.at(-1)?.params?.kind).not.toBe(current.kind);
    }
  });

  it('shows the item VALUE verbatim — it is the user/KB\'s word, not ours', () => {
    const { t, calls } = spy();
    delegateSubjectCopy(t)({ kind: 'category', value: 'Führungsverhalten' }, 1, 4);
    expect(calls.at(-1)?.params?.label).toBe('Führungsverhalten');
  });
});

describe('delegateParamLabel', () => {
  /** Every label code the schema's enum permits. */
  const CODES = ['entity-types', 'instructions', 'tone', 'density'] as const;

  it.each(CODES)('names a real en.json key for %s', (code) => {
    const { t, calls } = spy();
    delegateParamLabel(t)(code);
    const key = calls[0]?.key;
    expect(key).toBeDefined();
    expect(key! in NAMESPACE).toBe(true);
  });

  it('never renders the wire code itself for a known label', () => {
    // The codes are wire tokens — kebab-case and English. A user reading a
    // Japanese UI must never see "entity-types".
    const { t } = spy();
    for (const code of CODES) expect(delegateParamLabel(t)(code)).not.toBe(code);
  });

  it('falls back to the code for an unknown label rather than rendering nothing', () => {
    const { t } = spy();
    expect(delegateParamLabel(t)('future-param')).toBe('future-param');
  });
});
