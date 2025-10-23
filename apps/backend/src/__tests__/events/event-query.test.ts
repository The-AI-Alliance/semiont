/**
 * EventQuery Tests - Read operations with filtering
 *
 * Tests event queries with filters, limits, and edge cases
 *
 * @see docs/EVENT-STORE.md#eventquery
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventQuery } from '../../events/query/event-query';
import { EventStorage } from '../../events/storage/event-storage';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('EventQuery', () => {
  let testDir: string;
  let storage: EventStorage;
  let query: EventQuery;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-query-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    storage = new EventStorage({
      dataDir: testDir,
      enableSharding: false, // Faster for tests
      maxEventsPerFile: 100,
    });

    query = new EventQuery(storage);

    // Create test events for doc1
    await storage.appendEvent({
      type: 'document.created',
      userId: 'user1',
      documentId: 'doc1',
      version: 1,
      payload: { name: 'Doc1' },
    }, 'doc1');

    await storage.appendEvent({
      type: 'annotation.added',
      userId: 'user1',
      documentId: 'doc1',
      version: 1,
      payload: {},
    }, 'doc1');

    await storage.appendEvent({
      type: 'annotation.added',
      userId: 'user2',
      documentId: 'doc1',
      version: 1,
      payload: {},
    }, 'doc1');

    await storage.appendEvent({
      type: 'annotation.removed',
      userId: 'user1',
      documentId: 'doc1',
      version: 1,
      payload: {},
    }, 'doc1');

    await storage.appendEvent({
      type: 'entitytag.added',
      userId: 'user2',
      documentId: 'doc1',
      version: 1,
      payload: {},
    }, 'doc1');

    // Create events for doc2
    await storage.appendEvent({
      type: 'document.created',
      userId: 'user1',
      documentId: 'doc2',
      version: 1,
      payload: { name: 'Doc2' },
    }, 'doc2');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Basic Queries', () => {
    it('should get all events for document', async () => {
      const events = await query.getDocumentEvents('doc1');

      expect(events).toHaveLength(5);
      expect(events[0]?.event.type).toBe('document.created');
      expect(events[4]?.event.type).toBe('entitytag.added');
    });

    it('should return empty array for nonexistent document', async () => {
      const events = await query.getDocumentEvents('doc-nonexistent');

      expect(events).toEqual([]);
    });

    it('should get event count', async () => {
      const count = await query.getEventCount('doc1');

      expect(count).toBe(5);
    });

    it('should check if document has events', async () => {
      const hasEvents1 = await query.hasEvents('doc1');
      const hasEvents2 = await query.hasEvents('doc-nonexistent');

      expect(hasEvents1).toBe(true);
      expect(hasEvents2).toBe(false);
    });

    it('should get latest event', async () => {
      const latest = await query.getLatestEvent('doc1');

      expect(latest).not.toBeNull();
      expect(latest?.event.type).toBe('entitytag.added');
      expect(latest?.metadata.sequenceNumber).toBe(5);
    });

    it('should return null for latest event of empty document', async () => {
      const latest = await query.getLatestEvent('doc-nonexistent');

      expect(latest).toBeNull();
    });
  });

  describe('Filter by User', () => {
    it('should filter events by userId', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        userId: 'user1',
      });

      expect(events).toHaveLength(3);
      events.forEach(e => {
        expect(e.event.userId).toBe('user1');
      });
    });

    it('should filter events by different userId', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        userId: 'user2',
      });

      expect(events).toHaveLength(2);
      events.forEach(e => {
        expect(e.event.userId).toBe('user2');
      });
    });

    it('should return empty for nonexistent user', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        userId: 'user-nonexistent',
      });

      expect(events).toEqual([]);
    });
  });

  describe('Filter by Event Types', () => {
    it('should filter by single event type', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        eventTypes: ['annotation.added'],
      });

      expect(events).toHaveLength(2);
      events.forEach(e => {
        expect(e.event.type).toBe('annotation.added');
      });
    });

    it('should filter by multiple event types', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        eventTypes: ['annotation.added', 'annotation.removed'],
      });

      expect(events).toHaveLength(3);
      events.forEach(e => {
        expect(['annotation.added', 'annotation.removed']).toContain(e.event.type);
      });
    });

    it('should return empty for nonexistent event type', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        eventTypes: ['nonexistent.type'],
      });

      expect(events).toEqual([]);
    });

    it('should return all events for empty eventTypes array', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        eventTypes: [],
      });

      expect(events).toHaveLength(5);
    });
  });

  describe('Filter by Timestamp', () => {
    it('should filter by fromTimestamp', async () => {
      // Get all events first
      const allEvents = await query.getDocumentEvents('doc1');

      // Use 3rd event's timestamp as cutoff
      const cutoff = allEvents[2]?.event.timestamp!;

      const events = await query.queryEvents({
        documentId: 'doc1',
        fromTimestamp: cutoff,
      });

      // Should get events 3, 4, 5 (sequences 3-5)
      expect(events.length).toBeGreaterThanOrEqual(3);
      events.forEach(e => {
        expect(e.event.timestamp >= cutoff).toBe(true);
      });
    });

    it('should filter by toTimestamp', async () => {
      const allEvents = await query.getDocumentEvents('doc1');

      // Use 2nd event's timestamp as cutoff
      const cutoff = allEvents[1]?.event.timestamp!;

      const events = await query.queryEvents({
        documentId: 'doc1',
        toTimestamp: cutoff,
      });

      // Should get events 1, 2
      expect(events.length).toBeLessThanOrEqual(2);
      events.forEach(e => {
        expect(e.event.timestamp <= cutoff).toBe(true);
      });
    });

    it('should filter by timestamp range', async () => {
      const allEvents = await query.getDocumentEvents('doc1');

      const from = allEvents[1]?.event.timestamp!;
      const to = allEvents[3]?.event.timestamp!;

      const events = await query.queryEvents({
        documentId: 'doc1',
        fromTimestamp: from,
        toTimestamp: to,
      });

      // Should get events 2, 3, 4
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.length).toBeLessThanOrEqual(4);
      events.forEach(e => {
        expect(e.event.timestamp >= from).toBe(true);
        expect(e.event.timestamp <= to).toBe(true);
      });
    });

    it('should return empty for impossible timestamp range', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        fromTimestamp: '2099-01-01T00:00:00Z',
        toTimestamp: '2099-12-31T23:59:59Z',
      });

      expect(events).toEqual([]);
    });
  });

  describe('Filter by Sequence Number', () => {
    it('should filter by fromSequence', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        fromSequence: 3,
      });

      expect(events).toHaveLength(3);
      expect(events[0]?.metadata.sequenceNumber).toBe(3);
      expect(events[2]?.metadata.sequenceNumber).toBe(5);
    });

    it('should filter by fromSequence = 1 (all events)', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        fromSequence: 1,
      });

      expect(events).toHaveLength(5);
    });

    it('should return empty for fromSequence beyond max', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        fromSequence: 999,
      });

      expect(events).toEqual([]);
    });
  });

  describe('Limit Results', () => {
    it('should limit results to specified count', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        limit: 2,
      });

      expect(events).toHaveLength(2);
      expect(events[0]?.metadata.sequenceNumber).toBe(1);
      expect(events[1]?.metadata.sequenceNumber).toBe(2);
    });

    it('should limit results to 1', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        limit: 1,
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.event.type).toBe('document.created');
    });

    it('should handle limit larger than result set', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        limit: 100,
      });

      expect(events).toHaveLength(5);
    });

    it('should ignore zero limit', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        limit: 0,
      });

      expect(events).toHaveLength(5);
    });

    it('should ignore negative limit', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        limit: -1,
      });

      expect(events).toHaveLength(5);
    });
  });

  describe('Combined Filters', () => {
    it('should combine userId + eventTypes', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        userId: 'user1',
        eventTypes: ['annotation.added'],
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.event.userId).toBe('user1');
      expect(events[0]?.event.type).toBe('annotation.added');
    });

    it('should combine userId + limit', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        userId: 'user1',
        limit: 2,
      });

      expect(events).toHaveLength(2);
      events.forEach(e => {
        expect(e.event.userId).toBe('user1');
      });
    });

    it('should combine eventTypes + fromSequence + limit', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        eventTypes: ['annotation.added', 'annotation.removed'],
        fromSequence: 2,
        limit: 2,
      });

      expect(events.length).toBeLessThanOrEqual(2);
      events.forEach(e => {
        expect(['annotation.added', 'annotation.removed']).toContain(e.event.type);
        expect(e.metadata.sequenceNumber >= 2).toBe(true);
      });
    });

    it('should combine all filters', async () => {
      const allEvents = await query.getDocumentEvents('doc1');

      const events = await query.queryEvents({
        documentId: 'doc1',
        userId: 'user1',
        eventTypes: ['annotation.added', 'annotation.removed'],
        fromTimestamp: allEvents[0]?.event.timestamp!,
        toTimestamp: allEvents[4]?.event.timestamp!,
        fromSequence: 1,
        limit: 10,
      });

      events.forEach(e => {
        expect(e.event.userId).toBe('user1');
        expect(['annotation.added', 'annotation.removed']).toContain(e.event.type);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should require documentId', async () => {
      await expect(query.queryEvents({} as any)).rejects.toThrow('documentId is required');
    });

    it('should handle document with only document.created', async () => {
      const events = await query.getDocumentEvents('doc2');

      expect(events).toHaveLength(1);
      expect(events[0]?.event.type).toBe('document.created');
    });

    it('should handle getLastEvent for document with one file', async () => {
      const files = await storage.getEventFiles('doc1');
      const last = await query.getLastEvent('doc1', files[0]!);

      expect(last).not.toBeNull();
      expect(last?.metadata.sequenceNumber).toBe(5);
    });

    it('should handle getLastEvent for nonexistent file', async () => {
      const last = await query.getLastEvent('doc1', 'nonexistent.jsonl');

      expect(last).toBeNull();
    });

    it('should handle filters that match no events', async () => {
      const events = await query.queryEvents({
        documentId: 'doc1',
        userId: 'user-nonexistent',
        eventTypes: ['nonexistent.type'],
        fromSequence: 999,
        limit: 1,
      });

      expect(events).toEqual([]);
    });
  });

  describe('Performance', () => {
    it('should handle large result sets efficiently', async () => {
      // Add many events
      for (let i = 0; i < 100; i++) {
        await storage.appendEvent({
          type: 'annotation.added',
          userId: 'user1',
          documentId: 'doc-perf',
          version: 1,
          payload: { index: i },
        }, 'doc-perf');
      }

      const start = Date.now();
      const events = await query.getDocumentEvents('doc-perf');
      const duration = Date.now() - start;

      expect(events).toHaveLength(100);
      expect(duration).toBeLessThan(200); // Should be fast (<200ms)
    });

    it('should apply filters efficiently on large sets', async () => {
      // Add many events
      for (let i = 0; i < 100; i++) {
        await storage.appendEvent({
          type: i % 2 === 0 ? 'annotation.added' : 'annotation.removed',
          userId: i % 3 === 0 ? 'user1' : 'user2',
          documentId: 'doc-filter',
          version: 1,
          payload: { index: i },
        }, 'doc-filter');
      }

      const start = Date.now();
      const events = await query.queryEvents({
        documentId: 'doc-filter',
        userId: 'user1',
        eventTypes: ['annotation.added'],
        limit: 10,
      });
      const duration = Date.now() - start;

      expect(events.length).toBeLessThanOrEqual(10);
      expect(duration).toBeLessThan(100); // Should be fast (<100ms)
    });
  });
});
