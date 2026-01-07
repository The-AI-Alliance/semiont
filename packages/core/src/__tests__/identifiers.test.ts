import { describe, it, expect } from 'vitest';
import { generateResourceId, generateAnnotationId } from '../identifiers.js';

describe('@semiont/core - identifiers', () => {
  describe('generateResourceId', () => {
    it('should generate a valid resource ID', () => {
      const id = generateResourceId();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should generate unique IDs', () => {
      const id1 = generateResourceId();
      const id2 = generateResourceId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateAnnotationId', () => {
    it('should generate a valid annotation ID', () => {
      const id = generateAnnotationId();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should generate unique IDs', () => {
      const id1 = generateAnnotationId();
      const id2 = generateAnnotationId();
      expect(id1).not.toBe(id2);
    });
  });
});
