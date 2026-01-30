import { describe, it, expect } from 'vitest';
import { bodyItemsMatch, findBodyItem } from '../annotation-utils';
import type { BodyItem } from '../events';

describe('@semiont/core - annotation-utils', () => {
  describe('bodyItemsMatch', () => {
    it('should match identical TextualBody items', () => {
      const item1: BodyItem = { type: 'TextualBody', value: 'Test comment', purpose: 'commenting' };
      const item2: BodyItem = { type: 'TextualBody', value: 'Test comment', purpose: 'commenting' };

      expect(bodyItemsMatch(item1, item2)).toBe(true);
    });

    it('should not match TextualBody items with different values', () => {
      const item1: BodyItem = { type: 'TextualBody', value: 'Comment A', purpose: 'commenting' };
      const item2: BodyItem = { type: 'TextualBody', value: 'Comment B', purpose: 'commenting' };

      expect(bodyItemsMatch(item1, item2)).toBe(false);
    });

    it('should not match TextualBody items with different purposes', () => {
      const item1: BodyItem = { type: 'TextualBody', value: 'Test', purpose: 'commenting' };
      const item2: BodyItem = { type: 'TextualBody', value: 'Test', purpose: 'tagging' };

      expect(bodyItemsMatch(item1, item2)).toBe(false);
    });

    it('should match identical SpecificResource items', () => {
      const item1: BodyItem = { type: 'SpecificResource', source: 'https://example.com/ref', purpose: 'linking' };
      const item2: BodyItem = { type: 'SpecificResource', source: 'https://example.com/ref', purpose: 'linking' };

      expect(bodyItemsMatch(item1, item2)).toBe(true);
    });

    it('should not match SpecificResource items with different sources', () => {
      const item1: BodyItem = { type: 'SpecificResource', source: 'https://example.com/ref1', purpose: 'linking' };
      const item2: BodyItem = { type: 'SpecificResource', source: 'https://example.com/ref2', purpose: 'linking' };

      expect(bodyItemsMatch(item1, item2)).toBe(false);
    });

    it('should not match items with different types', () => {
      const item1: BodyItem = { type: 'TextualBody', value: 'Test', purpose: 'commenting' };
      const item2: BodyItem = { type: 'SpecificResource', source: 'Test', purpose: 'commenting' };

      expect(bodyItemsMatch(item1, item2)).toBe(false);
    });

    it('should match TextualBody items with undefined purpose', () => {
      const item1: BodyItem = { type: 'TextualBody', value: 'Test' };
      const item2: BodyItem = { type: 'TextualBody', value: 'Test' };

      expect(bodyItemsMatch(item1, item2)).toBe(true);
    });
  });

  describe('findBodyItem', () => {
    it('should find TextualBody item in array', () => {
      const body = [
        { type: 'TextualBody', value: 'First comment', purpose: 'commenting' },
        { type: 'TextualBody', value: 'Second comment', purpose: 'commenting' },
      ];
      const targetItem: BodyItem = { type: 'TextualBody', value: 'Second comment', purpose: 'commenting' };

      expect(findBodyItem(body, targetItem)).toBe(1);
    });

    it('should find SpecificResource item in array', () => {
      const body = [
        { type: 'TextualBody', value: 'Comment', purpose: 'commenting' },
        { type: 'SpecificResource', source: 'https://example.com/ref', purpose: 'linking' },
      ];
      const targetItem: BodyItem = { type: 'SpecificResource', source: 'https://example.com/ref', purpose: 'linking' };

      expect(findBodyItem(body, targetItem)).toBe(1);
    });

    it('should return -1 when item not found', () => {
      const body = [
        { type: 'TextualBody', value: 'First comment', purpose: 'commenting' },
      ];
      const targetItem: BodyItem = { type: 'TextualBody', value: 'Not found', purpose: 'commenting' };

      expect(findBodyItem(body, targetItem)).toBe(-1);
    });

    it('should return -1 for non-array body', () => {
      const body = { type: 'TextualBody', value: 'Single item', purpose: 'commenting' };
      const targetItem: BodyItem = { type: 'TextualBody', value: 'Single item', purpose: 'commenting' };

      expect(findBodyItem(body as any, targetItem)).toBe(-1);
    });

    it('should return -1 for empty array', () => {
      const body: any[] = [];
      const targetItem: BodyItem = { type: 'TextualBody', value: 'Test', purpose: 'commenting' };

      expect(findBodyItem(body, targetItem)).toBe(-1);
    });

    it('should handle array with invalid items', () => {
      const body = [
        null,
        'string item',
        42,
        { type: 'TextualBody', value: 'Valid comment', purpose: 'commenting' },
      ];
      const targetItem: BodyItem = { type: 'TextualBody', value: 'Valid comment', purpose: 'commenting' };

      expect(findBodyItem(body as any, targetItem)).toBe(3);
    });
  });
});
