import { describe, it, expect } from 'vitest';
import { extractEntityId, extractEventNumber, formatEventId } from '../identifier-utils.js';

describe('@semiont/event-sourcing - identifier-utils', () => {
  describe('formatEventId', () => {
    it('should format an event ID correctly', () => {
      const entityId = 'resource-123';
      const eventNumber = 5;
      const eventId = formatEventId(entityId, eventNumber);

      expect(eventId).toBeDefined();
      expect(typeof eventId).toBe('string');
      expect(eventId).toContain(entityId);
    });

    it('should handle different entity IDs', () => {
      const id1 = formatEventId('entity-1', 1);
      const id2 = formatEventId('entity-2', 1);

      expect(id1).not.toBe(id2);
    });
  });

  describe('extractEntityId', () => {
    it('should extract entity ID from event ID', () => {
      const entityId = 'resource-123';
      const eventId = formatEventId(entityId, 1);
      const extracted = extractEntityId(eventId);

      expect(extracted).toBe(entityId);
    });
  });

  describe('extractEventNumber', () => {
    it('should extract event number from event ID', () => {
      const eventNumber = 42;
      const eventId = formatEventId('resource-123', eventNumber);
      const extracted = extractEventNumber(eventId);

      expect(extracted).toBe(eventNumber);
    });
  });
});
