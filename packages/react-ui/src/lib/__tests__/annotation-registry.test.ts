import { describe, it, expect, vi } from 'vitest';
import { ANNOTATORS, annotatorKeyForMotivation } from '../annotation-registry';

// Mock http-transport type guards
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
  isHighlight: vi.fn((ann: any) => ann.motivation === 'highlighting'),
  isComment: vi.fn((ann: any) => ann.motivation === 'commenting'),
  isReference: vi.fn((ann: any) => ann.motivation === 'linking'),
  isTag: vi.fn((ann: any) => ann.motivation === 'tagging'),
  };
});

describe('annotation-registry ANNOTATORS', () => {
  describe('structure', () => {
    it('defines highlight, comment, assessment, reference, tag', () => {
      expect(Object.keys(ANNOTATORS)).toEqual(
        expect.arrayContaining(['highlight', 'comment', 'assessment', 'reference', 'tag'])
      );
    });

    it('each annotator has required fields', () => {
      for (const [, ann] of Object.entries(ANNOTATORS)) {
        expect(ann.motivation).toBeTruthy();
        expect(ann.internalType).toBeTruthy();
        expect(ann.displayName).toBeTruthy();
        expect(ann.className).toBeTruthy();
        expect(ann.iconEmoji).toBeTruthy();
        expect(typeof ann.matchesAnnotation).toBe('function');
      }
    });
  });

  describe('matchesAnnotation', () => {
    it('highlight matches highlighting motivation', () => {
      expect(ANNOTATORS.highlight.matchesAnnotation({ motivation: 'highlighting' } as any)).toBe(true);
      expect(ANNOTATORS.highlight.matchesAnnotation({ motivation: 'commenting' } as any)).toBe(false);
    });

    it('comment matches commenting motivation', () => {
      expect(ANNOTATORS.comment.matchesAnnotation({ motivation: 'commenting' } as any)).toBe(true);
    });

    it('reference matches linking motivation', () => {
      expect(ANNOTATORS.reference.matchesAnnotation({ motivation: 'linking' } as any)).toBe(true);
    });

    it('tag matches tagging motivation', () => {
      expect(ANNOTATORS.tag.matchesAnnotation({ motivation: 'tagging' } as any)).toBe(true);
    });
  });

  describe('annotatorKeyForMotivation', () => {
    it('maps every motivation to its annotator key (the panel tab key)', () => {
      expect(annotatorKeyForMotivation('highlighting')).toBe('highlight');
      expect(annotatorKeyForMotivation('commenting')).toBe('comment');
      expect(annotatorKeyForMotivation('assessing')).toBe('assessment');
      expect(annotatorKeyForMotivation('linking')).toBe('reference');
      expect(annotatorKeyForMotivation('tagging')).toBe('tag');
    });

    it('round-trips every registry entry (drift guard)', () => {
      for (const [key, annotator] of Object.entries(ANNOTATORS)) {
        expect(annotatorKeyForMotivation(annotator.motivation)).toBe(key);
      }
    });

    it('returns undefined for strings outside the Motivation union (loose event boundaries)', () => {
      // BrowsePanelOpenEvent.motivation is typed as Motivation in the schema,
      // but panel:open is not wire-validated at runtime — callers at that boundary need the miss case.
      expect(annotatorKeyForMotivation('bookmarking')).toBeUndefined();
      expect(annotatorKeyForMotivation('')).toBeUndefined();
    });
  });
});
