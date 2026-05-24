import { describe, it, expect } from 'vitest';
import {
  anchorAnnotation,
  POSITION_WINDOW,
  CONTEXT_FULL_WEIGHT,
  POSITION_WEIGHT_MAX,
  type RenderedAnchor,
} from '../anchor-annotation';

// ─── Layer 1: per-strategy unit tests ─────────────────────────────────────

describe('anchorAnnotation — fast-path', () => {
  it('returns the verified position when content[start..end] === exact', () => {
    const content = 'Kenison, C.J.\nThe question for decision';
    const result = anchorAnnotation(content, {
      position: { start: 14, end: 39 },
      quote: { exact: 'The question for decision' },
    });
    expect(result).toEqual<RenderedAnchor>({
      start: 14,
      end: 39,
      strategy: 'fast-path',
      confidence: 'high',
    });
  });

  it('does not take the fast path when content[start] does not begin exact', () => {
    const content = 'Kenison, C.J.\nThe question for decision';
    const result = anchorAnnotation(content, {
      position: { start: 16, end: 41 }, // off-by-two; substring is "e question for decision   " etc.
      quote: { exact: 'The question for decision' },
    });
    expect(result?.strategy).not.toBe('fast-path');
    // The exact text is unique in the content, so fallback is unique-occurrence.
    expect(result).toEqual<RenderedAnchor>({
      start: 14,
      end: 39,
      strategy: 'unique-occurrence',
      confidence: 'high',
    });
  });
});

describe('anchorAnnotation — unique-occurrence', () => {
  it('returns the single occurrence regardless of position hint', () => {
    const content = 'aaa BBB ccc';
    const result = anchorAnnotation(content, {
      position: { start: 0, end: 3 },
      quote: { exact: 'BBB' },
    });
    expect(result).toEqual<RenderedAnchor>({
      start: 4,
      end: 7,
      strategy: 'unique-occurrence',
      confidence: 'high',
    });
  });

  it('returns the single occurrence even with no position selector', () => {
    const content = 'aaa BBB ccc';
    const result = anchorAnnotation(content, { quote: { exact: 'BBB' } });
    expect(result).toEqual<RenderedAnchor>({
      start: 4,
      end: 7,
      strategy: 'unique-occurrence',
      confidence: 'high',
    });
  });
});

describe('anchorAnnotation — context-disambiguated', () => {
  const content =
    'Section A: the parties agree to terms. Section B: the parties agree to conditions. Section C: the parties agree to schedule.';

  it('high confidence when both prefix and suffix align exactly with one candidate', () => {
    const result = anchorAnnotation(content, {
      quote: {
        exact: 'the parties agree',
        prefix: 'Section B: ',
        suffix: ' to conditions',
      },
    });
    const candidateB = content.indexOf('Section B: ') + 'Section B: '.length;
    expect(result).toEqual<RenderedAnchor>({
      start: candidateB,
      end: candidateB + 'the parties agree'.length,
      strategy: 'context-disambiguated',
      confidence: 'high',
    });
  });

  it('matches with prefix-only when suffix is missing', () => {
    const result = anchorAnnotation(content, {
      quote: { exact: 'the parties agree', prefix: 'Section C: ' },
    });
    const candidateC = content.indexOf('Section C: ') + 'Section C: '.length;
    expect(result?.start).toBe(candidateC);
    expect(result?.strategy).toBe('context-disambiguated');
    expect(result?.confidence).toBe('high');
  });

  it('matches with suffix-only when prefix is missing', () => {
    const result = anchorAnnotation(content, {
      quote: { exact: 'the parties agree', suffix: ' to schedule' },
    });
    const candidateC = content.indexOf('Section C: ') + 'Section C: '.length;
    expect(result?.start).toBe(candidateC);
    expect(result?.strategy).toBe('context-disambiguated');
    expect(result?.confidence).toBe('high');
  });
});

describe('anchorAnnotation — position-tiebreaker', () => {
  it('picks the candidate closest to the position hint when context is absent', () => {
    const content = 'X foo Y foo Z foo W';
    // foo positions: 2, 8, 14
    const hint = 8;
    const result = anchorAnnotation(content, {
      position: { start: hint, end: hint + 3 },
      quote: { exact: 'foo' },
    });
    // Fast path takes 8 directly.
    expect(result?.start).toBe(8);
    expect(result?.strategy).toBe('fast-path');
  });

  it('picks the closest candidate when the hint is not exactly on any occurrence', () => {
    const content = 'X foo Y foo Z foo W';
    // foo at positions 2, 8, 14. Hint at 10 → closest is 8.
    const result = anchorAnnotation(content, {
      position: { start: 10, end: 13 },
      quote: { exact: 'foo' },
    });
    expect(result?.start).toBe(8);
    expect(result?.strategy).toBe('position-tiebreaker');
    expect(result?.confidence).toBe('medium');
  });

  it('falls back to first occurrence with low confidence when no signal differentiates', () => {
    // Build content where 'foo' appears twice, very far apart, hint is far from both.
    const gap = 'x'.repeat(POSITION_WINDOW * 3);
    const content = `foo${gap}foo`;
    const result = anchorAnnotation(content, {
      // No position hint at all → no signal, first occurrence wins.
      quote: { exact: 'foo' },
    });
    expect(result?.start).toBe(0);
    expect(result?.strategy).toBe('position-tiebreaker');
    expect(result?.confidence).toBe('low');
  });
});

describe('anchorAnnotation — no fuzzy recovery at render time', () => {
  it('does NOT fuzzy-match a near-miss; falls back to stored offset, flagged', () => {
    // 'helo world' isn't verbatim in the content. The renderer must not
    // guess — it renders at the stored offset and flags low-confidence.
    // (The write-side reconcileSelector is where fuzzy recovery belongs.)
    const content = 'The quick hello world appears here.';
    const result = anchorAnnotation(content, {
      position: { start: 4, end: 14 },
      quote: { exact: 'helo world' },
    });
    expect(result?.strategy).toBe('position-fallback');
    expect(result?.confidence).toBe('low');
    expect(result?.start).toBe(4);
    expect(result?.end).toBe(14);
  });

  it('does NOT case-fold a quote that differs only by case', () => {
    const content = 'The Quick Hello World appears here.';
    const result = anchorAnnotation(content, {
      position: { start: 10, end: 21 },
      quote: { exact: 'hello world' },
    });
    expect(result?.strategy).toBe('position-fallback');
    expect(result?.confidence).toBe('low');
  });

  it('does NOT smart-quote-fold; the legacy bug renders at stored offset, flagged', () => {
    // The legal-KB case: content has a smart quote, stored exact has a
    // straight quote. No verbatim match. The renderer keeps the stored
    // offset (it's the system of record) and flags it — correction is an
    // upstream concern (re-emit a corrected annotation event).
    const content = 'Kenison, C.J.\nThe question to “any person” today.';
    const result = anchorAnnotation(content, {
      position: { start: 16, end: 40 },
      quote: { exact: 'The question to "any person"' },
    });
    expect(result?.strategy).toBe('position-fallback');
    expect(result?.confidence).toBe('low');
    expect(result?.start).toBe(16);
  });
});

describe('anchorAnnotation — position-fallback', () => {
  it('uses position when no quote selector is given', () => {
    const content = 'some content';
    const result = anchorAnnotation(content, {
      position: { start: 5, end: 12 },
    });
    expect(result).toEqual<RenderedAnchor>({
      start: 5,
      end: 12,
      strategy: 'position-fallback',
      confidence: 'low',
    });
  });

  it('returns null when neither selector is usable', () => {
    expect(anchorAnnotation('content', {})).toBeNull();
    expect(anchorAnnotation('', { quote: { exact: 'anything' } })).toBeNull();
  });

  it('returns null when position is given but out of range and no quote', () => {
    expect(anchorAnnotation('hi', { position: { start: 5, end: 10 } })).toBeNull();
    expect(anchorAnnotation('hi', { position: { start: 0, end: 0 } })).toBeNull();
  });

  it('returns null when exact is not found verbatim and the stored offset is out of range', () => {
    const content = 'short';
    const result = anchorAnnotation(content, {
      position: { start: 50, end: 60 },
      quote: { exact: 'ZZZNEVERAPPEARSZZZ' },
    });
    expect(result).toBeNull();
  });

  it('falls back to raw position when exact is not found but offset is valid', () => {
    const content = 'this content has nothing matching the request';
    const result = anchorAnnotation(content, {
      position: { start: 5, end: 12 },
      quote: { exact: 'ZZZNEVERAPPEARSZZZ' },
    });
    expect(result?.strategy).toBe('position-fallback');
    expect(result?.confidence).toBe('low');
    expect(result?.start).toBe(5);
  });
});

// ─── Layer 1: cross-cutting + the motivating bug ────────────────────────

describe('anchorAnnotation — cross-cutting', () => {
  it('positional drift: stale offset 16, exact is verbatim-unique at 14', () => {
    // Stored offset is stale (16) but `exact` still exists verbatim and
    // unique in the content, at position 14. This is the safe render-time
    // recovery case: re-anchor to the verbatim match, high confidence.
    const exact = 'The question for decision';
    const content = `Kenison, C.J.\n${exact} by this appeal`;
    const result = anchorAnnotation(content, {
      position: { start: 16, end: 16 + exact.length },
      quote: {
        exact,
        prefix: 'Kenison, C.J.\nTh',
        suffix: ' by this appeal',
      },
    });
    expect(result?.start).toBe(14);
    expect(result?.end).toBe(14 + exact.length);
    expect(content.substring(result!.start, result!.end)).toBe(exact);
    expect(result?.confidence).toBe('high');
  });

  it('returned start/end always satisfy content.substring(start, end) === exact when exact is found', () => {
    const content = 'alpha beta gamma delta beta epsilon';
    const result = anchorAnnotation(content, { quote: { exact: 'beta' } });
    expect(result).not.toBeNull();
    expect(content.substring(result!.start, result!.end)).toBe('beta');
  });

  it('property-style: random offsets shifted by ±10 from the true position recover correctly', () => {
    const exact = 'target substring';
    const content = `prefix garbage ${exact} suffix garbage`;
    const truePos = content.indexOf(exact);
    for (const shift of [-10, -5, -1, 0, 1, 5, 10]) {
      const hint = truePos + shift;
      const result = anchorAnnotation(content, {
        position: { start: hint, end: hint + exact.length },
        quote: { exact },
      });
      expect(result?.start).toBe(truePos);
      expect(content.substring(result!.start, result!.end)).toBe(exact);
    }
  });
});

// ─── Layer 2: calibration tests pinning scoring boundaries ──────────────

describe('anchorAnnotation — calibration', () => {
  it('full-context match outranks position-close-with-no-context', () => {
    // Two candidates: one with full context far from hint, one with no
    // context near the hint. Full context must win.
    // Hint is offset by 2 chars from the near candidate so the fast path
    // doesn't short-circuit before the scorer runs.
    const farContext = 'BEFORE_CTX target AFTER_CTX';
    const filler = 'x'.repeat(5000);
    const nearNoContext = '  target';  // leading spaces so hint offset misses
    const content = `${nearNoContext} ${filler}${farContext}`;
    const nearTargetPos = content.indexOf('target'); // = 2
    const hint = nearTargetPos - 2; // = 0 — substring(0, 6) is "  targ", not "target"
    const result = anchorAnnotation(content, {
      position: { start: hint, end: hint + 'target'.length },
      quote: {
        exact: 'target',
        prefix: 'BEFORE_CTX ',
        suffix: ' AFTER_CTX',
      },
    });
    const expected = content.indexOf('BEFORE_CTX target') + 'BEFORE_CTX '.length;
    expect(result?.start).toBe(expected);
    expect(result?.strategy).toBe('context-disambiguated');
    expect(result?.confidence).toBe('high');
  });

  it('position-close outranks context-absent-far', () => {
    // Two candidates, no context on the input. Hint near one of them.
    const filler = 'x'.repeat(3000);
    const content = `target ${filler} target`;
    const hint = 0; // near the first occurrence
    const result = anchorAnnotation(content, {
      position: { start: hint, end: hint + 'target'.length },
      quote: { exact: 'target' },
    });
    // The first occurrence is at the hint — fast-path takes it.
    expect(result?.start).toBe(0);
  });

  it('position bias falls off past the window — equidistant outside window picks first', () => {
    const halfGap = POSITION_WINDOW * 2;
    const left = 'x'.repeat(halfGap);
    const mid = 'x'.repeat(halfGap);
    const content = `${left}target${mid}target`;
    const leftPos = content.indexOf('target');
    const rightPos = content.lastIndexOf('target');
    // Hint at exact midpoint between the two targets — both are equidistant
    // and both are well outside the position window, so both score 0 on
    // position. With no context, the deterministic tie-break is first-of.
    const hint = Math.floor((leftPos + rightPos) / 2);
    const result = anchorAnnotation(content, {
      position: { start: hint, end: hint + 'target'.length },
      quote: { exact: 'target' },
    });
    expect(result?.start).toBe(leftPos);
    expect(result?.strategy).toBe('position-tiebreaker');
    expect(result?.confidence).toBe('low');
  });

  it('CONTEXT_FULL_WEIGHT plus its partner outranks any position score', () => {
    // Invariant the algorithm depends on: even a single full-context-side
    // match (CONTEXT_FULL_WEIGHT) must outweigh the maximum position score
    // (POSITION_WEIGHT_MAX). Pin this so weight retuning doesn't break it.
    expect(CONTEXT_FULL_WEIGHT).toBeGreaterThan(POSITION_WEIGHT_MAX);
  });
});
