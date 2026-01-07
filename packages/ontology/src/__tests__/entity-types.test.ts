import { describe, it, expect } from 'vitest';
import { CORE_ENTITY_TYPES } from '../entity-types.js';

describe('@semiont/ontology - entity-types', () => {
  describe('CORE_ENTITY_TYPES', () => {
    it('should export core entity types', () => {
      expect(CORE_ENTITY_TYPES).toBeDefined();
      expect(Array.isArray(CORE_ENTITY_TYPES)).toBe(true);
      expect(CORE_ENTITY_TYPES.length).toBeGreaterThan(0);
    });

    it('should have entity types with required properties', () => {
      CORE_ENTITY_TYPES.forEach((entityType) => {
        expect(entityType).toHaveProperty('id');
        expect(entityType).toHaveProperty('name');
        expect(entityType).toHaveProperty('description');
        expect(typeof entityType.id).toBe('string');
        expect(typeof entityType.name).toBe('string');
        expect(entityType.id.length).toBeGreaterThan(0);
        expect(entityType.name.length).toBeGreaterThan(0);
      });
    });

    it('should have unique entity type IDs', () => {
      const ids = CORE_ENTITY_TYPES.map((et) => et.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should include common entity types', () => {
      const ids = CORE_ENTITY_TYPES.map((et) => et.id);

      // Check for some expected core entity types
      const expectedTypes = ['Person', 'Organization', 'Location'];
      expectedTypes.forEach((type) => {
        expect(ids).toContain(type);
      });
    });
  });
});
