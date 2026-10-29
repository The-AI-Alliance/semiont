import { describe, it, expect } from 'vitest';
import { annotationId, resourceId, type Annotation } from '@semiont/core';
import { ANNOTATORS, annotatorKeyForMotivation } from '../annotation-registry';

/** An annotation of `motivation` on a whole resource. */
function withMotivation(motivation: Annotation['motivation']): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId('ann-1'),
    motivation,
    target: resourceId('res-1'),
    created: '2026-01-01T00:00:00Z',
  };
}

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
      expect(ANNOTATORS.highlight.matchesAnnotation(withMotivation('highlighting'))).toBe(true);
      expect(ANNOTATORS.highlight.matchesAnnotation(withMotivation('commenting'))).toBe(false);
    });

    it('comment matches commenting motivation', () => {
      expect(ANNOTATORS.comment.matchesAnnotation(withMotivation('commenting'))).toBe(true);
    });

    it('reference matches linking motivation', () => {
      expect(ANNOTATORS.reference.matchesAnnotation(withMotivation('linking'))).toBe(true);
    });

    it('tag matches tagging motivation', () => {
      expect(ANNOTATORS.tag.matchesAnnotation(withMotivation('tagging'))).toBe(true);
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
