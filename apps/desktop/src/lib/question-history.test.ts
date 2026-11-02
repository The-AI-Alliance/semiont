import { describe, expect, it } from 'vitest';
import type { Annotation, ResourceId } from '@semiont/core';
import { historyStep, mentionsFromAnnotations, questionHistory, type RecallEntry } from './question-history';

const rid = (s: string) => s as unknown as ResourceId;

/** A resolved linking annotation as chat creates it: position + quote selectors, SpecificResource body. */
function referenceAnnotation(opts: { start: number; end: number; exact: string; referent: string; resolved?: boolean }): Annotation {
  return {
    id: `ann-${opts.start}`,
    motivation: 'linking',
    target: {
      source: 'q-1',
      selector: [
        { type: 'TextPositionSelector', start: opts.start, end: opts.end },
        { type: 'TextQuoteSelector', exact: opts.exact },
      ],
    },
    ...(opts.resolved !== false ? { body: { type: 'SpecificResource', source: opts.referent, purpose: 'linking' } } : {}),
  } as unknown as Annotation;
}

describe('historyStep (readline cursor over past questions; null = the live draft)', () => {
  it('Up from the draft recalls the newest question (index 0)', () => {
    expect(historyStep(3, null, 'up')).toBe(0);
  });

  it('Up keeps going back and clamps at the oldest', () => {
    expect(historyStep(3, 0, 'up')).toBe(1);
    expect(historyStep(3, 1, 'up')).toBe(2);
    expect(historyStep(3, 2, 'up')).toBe(2); // clamp — no wrap
  });

  it('Down walks forward and lands back on the draft past the newest', () => {
    expect(historyStep(3, 2, 'down')).toBe(1);
    expect(historyStep(3, 1, 'down')).toBe(0);
    expect(historyStep(3, 0, 'down')).toBe(null); // back to the stashed draft
  });

  it('is inert with no history, and Down from the draft stays on the draft', () => {
    expect(historyStep(0, null, 'up')).toBe(null);
    expect(historyStep(3, null, 'down')).toBe(null);
  });
});

describe('questionHistory (chronological turns → newest-first recall entries pointing at their resources)', () => {
  it('reverses to newest-first, carrying each turn’s question-resource id', () => {
    const recall: RecallEntry[] = questionHistory([
      { question: 'about Iowa please', questionId: rid('q-1') },
      { question: 'plain question' },
    ]);
    expect(recall).toEqual([
      { text: 'plain question' },
      { text: 'about Iowa please', questionId: rid('q-1') },
    ]);
  });

  it('dedupes repeats by text, keeping the most recent occurrence (and its resource id)', () => {
    const recall = questionHistory([
      { question: 'ask A', questionId: rid('q-old') },
      { question: 'ask B' },
      { question: 'ask A', questionId: rid('q-new') },
    ]);
    expect(recall.map((e) => e.text)).toEqual(['ask A', 'ask B']);
    expect(recall[0]?.questionId).toEqual(rid('q-new'));
  });

  it('drops empty questions', () => {
    expect(questionHistory([{ question: '' }, { question: 'real question' }, { question: '  ' }])).toEqual([
      { text: 'real question' },
    ]);
  });
});

describe('mentionsFromAnnotations (chip reconstruction from the question resource’s own annotations)', () => {
  const text = 'Compare Iowa with the plague records';

  it('derives a composer mention from a resolved linking annotation (platform vocabulary in, chip shape out)', () => {
    const anns = [referenceAnnotation({ start: 8, end: 12, exact: 'Iowa', referent: 'doc-iowa' })];
    expect(mentionsFromAnnotations(text, anns)).toEqual([
      { kind: 'resource', name: 'Iowa', resourceId: rid('doc-iowa'), start: 8, end: 12 },
    ]);
  });

  it('skips unresolved stubs and selector-less (resource-level) references', () => {
    const stub = referenceAnnotation({ start: 8, end: 12, exact: 'Iowa', referent: '', resolved: false });
    const resourceLevel = {
      id: 'ann-rl',
      motivation: 'linking',
      target: { source: 'q-1' },
      body: { type: 'SpecificResource', source: 'doc-x', purpose: 'linking' },
    } as unknown as Annotation;
    expect(mentionsFromAnnotations(text, [stub, resourceLevel])).toEqual([]);
  });

  it('skips offsets that no longer match the text, sorts by position, and drops overlaps left-to-right', () => {
    const anns = [
      referenceAnnotation({ start: 22, end: 28, exact: 'plague', referent: 'doc-plague' }),
      referenceAnnotation({ start: 8, end: 12, exact: 'Iowa', referent: 'doc-iowa' }),
      referenceAnnotation({ start: 10, end: 16, exact: 'wa wit', referent: 'doc-overlap' }), // overlaps Iowa
      referenceAnnotation({ start: 30, end: 99, exact: 'records', referent: 'doc-oob' }), // out of bounds
    ];
    expect(mentionsFromAnnotations(text, anns).map((m) => String(m.resourceId))).toEqual(['doc-iowa', 'doc-plague']);
  });
});
