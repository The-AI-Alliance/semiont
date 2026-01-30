/**
 * EventLog Tests
 * Tests for event persistence wrapper layer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventLog } from '../event-log';
import { resourceId, userId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('EventLog', () => {
  let testDir: string;
  let log: EventLog;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-eventlog-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    log = new EventLog({
      basePath: testDir,
      dataDir: testDir,
      enableSharding: true,
      maxEventsPerFile: 100,
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Constructor', () => {
    it('should create EventLog with config', () => {
      expect(log).toBeDefined();
      expect(log.storage).toBeDefined();
    });

    it('should use default values for optional config', () => {
      const defaultLog = new EventLog({
        basePath: testDir,
        dataDir: testDir,
      });

      expect(defaultLog).toBeDefined();
      expect(defaultLog.storage).toBeDefined();
    });
  });

  describe('append()', () => {
    it('should append event and return stored event', async () => {
      const event = {
        type: 'resource.created' as const,
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {
          name: 'Test Document',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      };

      const stored = await log.append(event, resourceId('doc1'));

      expect(stored.event.id).toBeDefined();
      expect(stored.event.timestamp).toBeDefined();
      expect(stored.event.type).toBe('resource.created');
      expect(stored.metadata.sequenceNumber).toBe(1);
    });

    it('should delegate to storage.appendEvent', async () => {
      const event = {
        type: 'annotation.added' as const,
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            id: 'http://example.com/annotations/anno1',
            type: 'Annotation' as const,
            motivation: 'commenting' as const,
            body: [],
            target: 'http://example.com/resources/doc1',
          },
        },
      };

      const stored = await log.append(event, resourceId('doc1'));

      expect(stored).toBeDefined();
      expect(stored.event.type).toBe('annotation.added');
    });
  });

  describe('getEvents()', () => {
    it('should retrieve all events for a resource', async () => {
      const rid = resourceId('doc1');
      const uid = userId('user1');

      await log.append({
        type: 'resource.created' as const,
        userId: uid,
        resourceId: rid,
        version: 1,
        payload: {
          name: 'Test',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      }, rid);

      await log.append({
        type: 'representation.added' as const,
        userId: uid,
        resourceId: rid,
        version: 1,
        payload: {
          representation: {
            '@id': 'checksum1',
            mediaType: 'text/plain',
            byteSize: 100,
            checksum: 'checksum1',
            created: new Date().toISOString(),
          },
        },
      }, rid);

      const events = await log.getEvents(rid);

      expect(events).toHaveLength(2);
      expect(events[0].event.type).toBe('resource.created');
      expect(events[1].event.type).toBe('representation.added');
    });

    it('should return empty array for resource with no events', async () => {
      const events = await log.getEvents(resourceId('nonexistent'));
      expect(events).toEqual([]);
    });
  });

  describe('getAllResourceIds()', () => {
    it('should return all resource IDs', async () => {
      const rid1 = resourceId('doc1');
      const rid2 = resourceId('doc2');
      const uid = userId('user1');

      await log.append({
        type: 'resource.created' as const,
        userId: uid,
        resourceId: rid1,
        version: 1,
        payload: {
          name: 'Doc 1',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      }, rid1);

      await log.append({
        type: 'resource.created' as const,
        userId: uid,
        resourceId: rid2,
        version: 1,
        payload: {
          name: 'Doc 2',
          format: 'text/plain' as const,
          contentChecksum: 'checksum2',
          creationMethod: 'api' as const,
        },
      }, rid2);

      const ids = await log.getAllResourceIds();

      expect(ids).toContain(rid1);
      expect(ids).toContain(rid2);
      expect(ids.length).toBeGreaterThanOrEqual(2);
    });

    it('should return empty array when no resources exist', async () => {
      const ids = await log.getAllResourceIds();
      expect(ids).toEqual([]);
    });
  });

  describe('queryEvents()', () => {
    beforeEach(async () => {
      const rid = resourceId('doc1');
      const uid1 = userId('user1');
      const uid2 = userId('user2');

      // Create multiple events
      await log.append({
        type: 'resource.created' as const,
        userId: uid1,
        resourceId: rid,
        version: 1,
        payload: {
          name: 'Test',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      }, rid);

      await log.append({
        type: 'representation.added' as const,
        userId: uid1,
        resourceId: rid,
        version: 1,
        payload: {
          representation: {
            '@id': 'checksum1',
            mediaType: 'text/plain',
            byteSize: 100,
            checksum: 'checksum1',
            created: new Date().toISOString(),
          },
        },
      }, rid);

      await log.append({
        type: 'annotation.added' as const,
        userId: uid2,
        resourceId: rid,
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            id: 'http://example.com/annotations/anno1',
            type: 'Annotation' as const,
            motivation: 'commenting' as const,
            body: [],
            target: 'http://example.com/resources/doc1',
          },
        },
      }, rid);
    });

    it('should return all events when no filter provided', async () => {
      const events = await log.queryEvents(resourceId('doc1'));
      expect(events).toHaveLength(3);
    });

    it('should filter by event types', async () => {
      const events = await log.queryEvents(resourceId('doc1'), {
        eventTypes: ['annotation.added'],
      });

      expect(events).toHaveLength(1);
      expect(events[0].event.type).toBe('annotation.added');
    });

    it('should filter by multiple event types', async () => {
      const events = await log.queryEvents(resourceId('doc1'), {
        eventTypes: ['resource.created', 'representation.added'],
      });

      expect(events).toHaveLength(2);
      expect(events[0].event.type).toBe('resource.created');
      expect(events[1].event.type).toBe('representation.added');
    });

    it('should filter by fromSequence', async () => {
      const events = await log.queryEvents(resourceId('doc1'), {
        fromSequence: 2,
      });

      expect(events).toHaveLength(2);
      expect(events[0].metadata.sequenceNumber).toBeGreaterThanOrEqual(2);
    });

    it('should filter by userId', async () => {
      const events = await log.queryEvents(resourceId('doc1'), {
        userId: userId('user2'),
      });

      expect(events).toHaveLength(1);
      expect(events[0].event.userId).toBe(userId('user2'));
    });

    it('should filter by fromTimestamp', async () => {
      const allEvents = await log.getEvents(resourceId('doc1'));
      const midTimestamp = allEvents[1].event.timestamp;

      const events = await log.queryEvents(resourceId('doc1'), {
        fromTimestamp: midTimestamp,
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.every(e => e.event.timestamp >= midTimestamp)).toBe(true);
    });

    it('should filter by toTimestamp', async () => {
      const allEvents = await log.getEvents(resourceId('doc1'));
      const midTimestamp = allEvents[1].event.timestamp;

      const events = await log.queryEvents(resourceId('doc1'), {
        toTimestamp: midTimestamp,
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.every(e => e.event.timestamp <= midTimestamp)).toBe(true);
    });

    it('should combine multiple filters', async () => {
      const events = await log.queryEvents(resourceId('doc1'), {
        eventTypes: ['resource.created', 'representation.added'],
        userId: userId('user1'),
      });

      expect(events).toHaveLength(2);
      expect(events.every(e => e.event.userId === userId('user1'))).toBe(true);
    });
  });
});
