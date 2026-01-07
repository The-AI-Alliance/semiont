import { describe, it, expect } from 'vitest';
import { createGraphClient } from '../factory.js';

describe('@semiont/graph - factory', () => {
  describe('createGraphClient', () => {
    it('should create a memory graph client', () => {
      const client = createGraphClient({ type: 'memory' });

      expect(client).toBeDefined();
      expect(client).toHaveProperty('addNode');
      expect(client).toHaveProperty('addEdge');
      expect(client).toHaveProperty('getNode');
      expect(client).toHaveProperty('query');
    });

    it('should throw error for unsupported graph types', () => {
      expect(() => {
        // @ts-expect-error - testing invalid type
        createGraphClient({ type: 'invalid-type' });
      }).toThrow();
    });
  });
});
