import { describe, it, expect } from 'vitest';
import { createGraphDatabase } from '../factory.js';

describe('@semiont/graph - factory', () => {
  describe('createGraphDatabase', () => {
    it('should create a memory graph database', () => {
      const db = createGraphDatabase({ type: 'memory' });

      expect(db).toBeDefined();
      expect(db).toHaveProperty('connect');
      expect(db).toHaveProperty('disconnect');
      expect(db).toHaveProperty('isConnected');
    });

    it('should throw error for unsupported graph types', () => {
      expect(() => {
        // @ts-expect-error - testing invalid type
        createGraphDatabase({ type: 'invalid-type' });
      }).toThrow('Unsupported graph database type');
    });
  });
});
