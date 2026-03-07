import { describe, it, expect, vi } from 'vitest';
import { ANNOTATORS } from '../annotation-registry';

// Mock api-client type guards
vi.mock('@semiont/api-client', () => ({
  isHighlight: vi.fn((ann: any) => ann.motivation === 'highlighting'),
  isComment: vi.fn((ann: any) => ann.motivation === 'commenting'),
  isReference: vi.fn((ann: any) => ann.motivation === 'linking'),
  isTag: vi.fn((ann: any) => ann.motivation === 'tagging'),
}));

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
        expect(ann.create).toBeTruthy();
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

  describe('detection.formatRequestParams', () => {
    it('highlight formats instructions and density', () => {
      const fmt = ANNOTATORS.highlight.detection!.formatRequestParams!;
      const result = fmt(['Find key terms', undefined, 5]);
      expect(result).toEqual([
        { label: 'Instructions', value: 'Find key terms' },
        { label: 'Density', value: '5 per 2000 words' },
      ]);
    });

    it('highlight returns empty for no args', () => {
      const fmt = ANNOTATORS.highlight.detection!.formatRequestParams!;
      expect(fmt([undefined, undefined, undefined])).toEqual([]);
    });

    it('comment formats instructions, tone, and density', () => {
      const fmt = ANNOTATORS.comment.detection!.formatRequestParams!;
      const result = fmt(['Analyze', 'academic', 3]);
      expect(result).toEqual([
        { label: 'Instructions', value: 'Analyze' },
        { label: 'Tone', value: 'academic' },
        { label: 'Density', value: '3 per 2000 words' },
      ]);
    });

    it('reference formats entity types and descriptive flag', () => {
      const fmt = ANNOTATORS.reference.detection!.formatRequestParams!;
      const result = fmt([['Person', 'Place'], true]);
      expect(result).toEqual([
        { label: 'Entity Types', value: 'Person, Place' },
        { label: 'Include Descriptive References', value: 'Yes' },
      ]);
    });

    it('reference returns empty for no types', () => {
      const fmt = ANNOTATORS.reference.detection!.formatRequestParams!;
      expect(fmt([[], false])).toEqual([]);
    });

    it('tag formats schema and categories', () => {
      const fmt = ANNOTATORS.tag.detection!.formatRequestParams!;
      const result = fmt(['legal-irac', ['Issue', 'Rule']]);
      expect(result).toEqual([
        { label: 'Schema', value: 'Legal (IRAC)' },
        { label: 'Categories', value: 'Issue, Rule' },
      ]);
    });

    it('tag formats unknown schema name as-is', () => {
      const fmt = ANNOTATORS.tag.detection!.formatRequestParams!;
      const result = fmt(['custom-schema', []]);
      expect(result).toEqual([
        { label: 'Schema', value: 'custom-schema' },
      ]);
    });

    it('tag returns empty for no schema and no categories', () => {
      const fmt = ANNOTATORS.tag.detection!.formatRequestParams!;
      expect(fmt([undefined, undefined])).toEqual([]);
    });
  });
});
