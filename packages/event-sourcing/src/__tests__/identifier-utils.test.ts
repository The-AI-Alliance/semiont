import { describe, it, expect } from 'vitest';
import { generateAnnotationId } from '../identifier-utils.js';

describe('@semiont/event-sourcing - identifier-utils', () => {
  describe('generateAnnotationId', () => {
    it('should generate a bare annotation ID (nanoid)', () => {
      const id = generateAnnotationId();

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBe(21);
      // Should NOT contain URI patterns
      expect(id).not.toContain('://');
      expect(id).not.toContain('/annotations/');
    });

    it('should generate unique IDs', () => {
      const id1 = generateAnnotationId();
      const id2 = generateAnnotationId();

      expect(id1).not.toBe(id2);
    });
  });
});
