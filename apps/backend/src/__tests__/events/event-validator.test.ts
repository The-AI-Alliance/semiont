/**
 * EventValidator Tests - Chain integrity validation
 *
 * Tests cryptographic chain validation and tampering detection
 *
 * @see docs/EVENT-STORE.md#eventvalidator
 */

import { describe, it, expect } from 'vitest';
import { EventValidator } from '../../events/validation/event-validator';
import type { StoredEvent, DocumentEvent } from '@semiont/core';
import { sha256 } from '../../storage/shard-utils';

describe('EventValidator', () => {
  let validator: EventValidator;

  beforeEach(() => {
    validator = new EventValidator();
  });

  // Helper to create StoredEvent with proper checksum
  function createStoredEvent(
    event: Partial<DocumentEvent>,
    sequenceNumber: number,
    prevChecksum?: string
  ): StoredEvent {
    const fullEvent: DocumentEvent = {
      id: `event-${sequenceNumber}`,
      type: event.type || 'document.created',
      userId: event.userId || 'user1',
      documentId: event.documentId || 'doc1',
      timestamp: new Date().toISOString(),
      version: 1,
      payload: event.payload || {},
    };

    const checksum = sha256(fullEvent);

    return {
      event: fullEvent,
      metadata: {
        sequenceNumber,
        streamPosition: sequenceNumber - 1,
        timestamp: fullEvent.timestamp,
        checksum,
        prevEventHash: prevChecksum,
      },
    };
  }

  describe('Event Chain Validation', () => {
    it('should validate a valid event chain', () => {
      const e1 = createStoredEvent({ type: 'document.created' }, 1);
      const e2 = createStoredEvent({ type: 'annotation.added' }, 2, e1.metadata.checksum);
      const e3 = createStoredEvent({ type: 'annotation.added' }, 3, e2.metadata.checksum);

      const result = validator.validateEventChain([e1, e2, e3]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate single event (no prevEventHash)', () => {
      const e1 = createStoredEvent({ type: 'document.created' }, 1);

      const result = validator.validateEventChain([e1]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate empty chain', () => {
      const result = validator.validateEventChain([]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect broken chain (wrong prevEventHash)', () => {
      const e1 = createStoredEvent({ type: 'document.created' }, 1);
      const e2 = createStoredEvent({ type: 'annotation.added' }, 2, 'wrong-hash');
      const e3 = createStoredEvent({ type: 'annotation.added' }, 3, e2.metadata.checksum);

      const result = validator.validateEventChain([e1, e2, e3]);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Event chain broken at sequence 2');
      expect(result.errors[0]).toContain('prevEventHash=wrong-hash');
    });

    it('should detect tampered checksum', () => {
      const e1 = createStoredEvent({ type: 'document.created' }, 1);
      const e2 = createStoredEvent({ type: 'annotation.added' }, 2, e1.metadata.checksum);

      // Tamper with event payload but keep old checksum
      e2.event.payload = { tampered: true };

      const result = validator.validateEventChain([e1, e2]);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Checksum mismatch at sequence 2');
    });

    it('should detect multiple errors in chain', () => {
      const e1 = createStoredEvent({ type: 'document.created' }, 1);
      const e2 = createStoredEvent({ type: 'annotation.added' }, 2, 'wrong-hash-1');
      const e3 = createStoredEvent({ type: 'annotation.added' }, 3, 'wrong-hash-2');

      // Also tamper with e3's checksum
      e3.event.payload = { tampered: true };

      const result = validator.validateEventChain([e1, e2, e3]);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it('should validate long chains efficiently', () => {
      const events: StoredEvent[] = [];

      // Create chain of 100 events
      for (let i = 1; i <= 100; i++) {
        const prevChecksum = i > 1 ? events[i - 2]!.metadata.checksum : undefined;
        events.push(createStoredEvent({ type: 'annotation.added', payload: { index: i } }, i, prevChecksum));
      }

      const start = Date.now();
      const result = validator.validateEventChain(events);
      const duration = Date.now() - start;

      expect(result.valid).toBe(true);
      expect(duration).toBeLessThan(100); // Should be fast (<100ms for 100 events)
    });
  });

  describe('Single Event Checksum Validation', () => {
    it('should validate correct checksum', () => {
      const event = createStoredEvent({ type: 'document.created', payload: { name: 'Test' } }, 1);

      const isValid = validator.validateEventChecksum(event);

      expect(isValid).toBe(true);
    });

    it('should detect incorrect checksum', () => {
      const event = createStoredEvent({ type: 'document.created', payload: { name: 'Test' } }, 1);

      // Tamper with checksum
      event.metadata.checksum = 'incorrect-checksum';

      const isValid = validator.validateEventChecksum(event);

      expect(isValid).toBe(false);
    });

    it('should detect tampered event payload', () => {
      const event = createStoredEvent({ type: 'document.created', payload: { name: 'Test' } }, 1);

      // Tamper with payload but keep original checksum
      const originalChecksum = event.metadata.checksum;
      event.event.payload = { name: 'Tampered' };

      const isValid = validator.validateEventChecksum(event);

      expect(isValid).toBe(false);
    });

    it('should validate different event types', () => {
      const events = [
        createStoredEvent({ type: 'document.created' }, 1),
        createStoredEvent({ type: 'document.archived' }, 2),
        createStoredEvent({ type: 'annotation.added' }, 3),
        createStoredEvent({ type: 'annotation.removed' }, 4),
        createStoredEvent({ type: 'entitytype.added' }, 5),
      ];

      events.forEach(event => {
        expect(validator.validateEventChecksum(event)).toBe(true);
      });
    });
  });

  describe('Event Link Validation', () => {
    it('should validate first event (no previous)', () => {
      const event = createStoredEvent({ type: 'document.created' }, 1);

      const isValid = validator.validateEventLink(event, null);

      expect(isValid).toBe(true);
    });

    it('should validate correctly linked events', () => {
      const prev = createStoredEvent({ type: 'document.created' }, 1);
      const current = createStoredEvent({ type: 'annotation.added' }, 2, prev.metadata.checksum);

      const isValid = validator.validateEventLink(current, prev);

      expect(isValid).toBe(true);
    });

    it('should detect incorrectly linked events', () => {
      const prev = createStoredEvent({ type: 'document.created' }, 1);
      const current = createStoredEvent({ type: 'annotation.added' }, 2, 'wrong-hash');

      const isValid = validator.validateEventLink(current, prev);

      expect(isValid).toBe(false);
    });

    it('should reject first event with prevEventHash', () => {
      const event = createStoredEvent({ type: 'document.created' }, 1, 'unexpected-hash');

      const isValid = validator.validateEventLink(event, null);

      expect(isValid).toBe(false);
    });

    it('should reject event without prevEventHash when previous exists', () => {
      const prev = createStoredEvent({ type: 'document.created' }, 1);
      const current = createStoredEvent({ type: 'annotation.added' }, 2); // No prevEventHash

      const isValid = validator.validateEventLink(current, prev);

      expect(isValid).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle events with identical payloads but different IDs', () => {
      const e1 = createStoredEvent({ type: 'annotation.added', payload: { value: 'same' } }, 1);
      const e2 = createStoredEvent({ type: 'annotation.added', payload: { value: 'same' } }, 2, e1.metadata.checksum);

      // Different IDs mean different checksums
      expect(e1.metadata.checksum).not.toBe(e2.metadata.checksum);

      const result = validator.validateEventChain([e1, e2]);
      expect(result.valid).toBe(true);
    });

    it('should handle events with large payloads', () => {
      const largePayload = {
        data: 'x'.repeat(10000), // 10KB string
        nested: {
          array: Array.from({ length: 100 }, (_, i) => ({ id: i, value: `item-${i}` })),
        },
      };

      const event = createStoredEvent({ type: 'annotation.added', payload: largePayload }, 1);

      const isValid = validator.validateEventChecksum(event);
      expect(isValid).toBe(true);
    });

    it('should handle events with complex nested objects', () => {
      const complexPayload = {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          'type': 'Annotation',
          target: {
            source: 'doc1',
            selector: {
              type: 'TextPositionSelector',
              exact: 'text',
              offset: 0,
              length: 4,
            },
          },
          body: [
            { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
            { type: 'SpecificResource', source: 'doc2' },
          ],
        },
      };

      const event = createStoredEvent({ type: 'annotation.added', payload: complexPayload }, 1);

      const isValid = validator.validateEventChecksum(event);
      expect(isValid).toBe(true);
    });

    it('should detect subtle payload modifications', () => {
      const event = createStoredEvent({
        type: 'annotation.added',
        payload: { name: 'Test', count: 42, flag: true },
      }, 1);

      const originalChecksum = event.metadata.checksum;

      // Subtle modifications
      const modifications = [
        { name: 'Test ', count: 42, flag: true }, // Extra space
        { name: 'Test', count: '42', flag: true }, // Type change
        { name: 'Test', count: 42, flag: 'true' }, // Type change
        { count: 42, name: 'Test', flag: true }, // Different property order (should have same checksum)
      ];

      modifications.forEach((modifiedPayload, index) => {
        event.event.payload = modifiedPayload;
        event.metadata.checksum = originalChecksum;

        const isValid = validator.validateEventChecksum(event);

        if (index === 3) {
          // Property order shouldn't matter for JSON
          expect(isValid).toBe(true);
        } else {
          expect(isValid).toBe(false);
        }
      });
    });
  });
});
