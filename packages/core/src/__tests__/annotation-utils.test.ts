import { describe, it, expect } from 'vitest';
import { findBodyItem } from '../annotation-utils';
import type { BodyItem } from '../events';

describe('@semiont/core - annotation-utils', () => {
  describe('findBodyItem', () => {
    it('should find TextualBody item in array', () => {
      const body: BodyItem[] = [
        { type: 'TextualBody', value: 'First comment', purpose: 'commenting' },
        { type: 'TextualBody', value: 'Second comment', purpose: 'commenting' },
      ];
      const targetItem: BodyItem = { type: 'TextualBody', value: 'Second comment', purpose: 'commenting' };

      expect(findBodyItem(body as any, targetItem)).toBe(1);
    });

    it('should find SpecificResource item in array', () => {
      const body: BodyItem[] = [
        { type: 'TextualBody', value: 'Comment', purpose: 'commenting' },
        { type: 'SpecificResource', source: 'https://example.com/ref', purpose: 'linking' },
      ];
      const targetItem: BodyItem = { type: 'SpecificResource', source: 'https://example.com/ref', purpose: 'linking' };

      expect(findBodyItem(body as any, targetItem)).toBe(1);
    });

    it('should return -1 when item not found', () => {
      const body: BodyItem[] = [
        { type: 'TextualBody', value: 'First comment', purpose: 'commenting' },
      ];
      const targetItem: BodyItem = { type: 'TextualBody', value: 'Not found', purpose: 'commenting' };

      expect(findBodyItem(body as any, targetItem)).toBe(-1);
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
