import { describe, it, expect } from 'vitest';
import { DEFAULT_ENTITY_TYPES } from '../entity-types.js';

describe('@semiont/ontology - entity-types', () => {
  describe('DEFAULT_ENTITY_TYPES', () => {
    it('should export default entity types', () => {
      expect(DEFAULT_ENTITY_TYPES).toBeDefined();
      expect(Array.isArray(DEFAULT_ENTITY_TYPES)).toBe(true);
      expect(DEFAULT_ENTITY_TYPES.length).toBeGreaterThan(0);
    });

    it('should have entity types as strings', () => {
      DEFAULT_ENTITY_TYPES.forEach((entityType: string) => {
        expect(typeof entityType).toBe('string');
        expect(entityType.length).toBeGreaterThan(0);
      });
    });

    it('should have unique entity types', () => {
      const uniqueTypes = new Set(DEFAULT_ENTITY_TYPES);
      expect(uniqueTypes.size).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it('should include common entity types', () => {
      const expectedTypes = ['Person', 'Organization', 'Location'];
      expectedTypes.forEach((type: string) => {
        expect(DEFAULT_ENTITY_TYPES).toContain(type);
      });
    });
  });
});
