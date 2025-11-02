/**
 * EventStorage Tests - Physical storage layer
 *
 * Tests JSONL file I/O, sharding, file rotation, and sequence tracking
 *
 * @see docs/EVENT-STORE.md#eventstorage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStorage } from '../../events/storage/event-storage';
import { resourceId, userId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('EventStorage', () => {
  let testDir: string;
  let storage: EventStorage;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-storage-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    storage = new EventStorage({
      basePath: testDir,
      dataDir: testDir,
      enableSharding: true,
      maxEventsPerFile: 3, // Small for testing rotation
      numShards: 256, // Smaller for testing
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Event Creation', () => {
    it('should generate ID and timestamp for new events', async () => {
      const stored = await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain' as const, contentChecksum: 'checksum1', creationMethod: 'api' as const },
      }, 'doc1');

      expect(stored.event.id).toBeDefined();
      expect(stored.event.id).toHaveLength(36); // UUID format
      expect(stored.event.timestamp).toBeDefined();
      expect(new Date(stored.event.timestamp)).toBeInstanceOf(Date);
    });

    it('should calculate checksums for events', async () => {
      const stored = await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain' as const, contentChecksum: 'checksum1', creationMethod: 'api' as const },
      }, 'doc1');

      expect(stored.metadata.checksum).toBeDefined();
      expect(stored.metadata.checksum).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should link events with prevEventHash', async () => {
      const e1 = await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain' as const, contentChecksum: 'checksum1', creationMethod: 'api' as const },
      }, 'doc1');

      const e2 = await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            type: 'Annotation' as const,
            id: 'anno1',
            motivation: 'highlighting' as const,
            target: { source: 'doc1' },
            body: []
          }
        },
      }, 'doc1');

      expect(e1.metadata.prevEventHash).toBeUndefined();
      expect(e2.metadata.prevEventHash).toBe(e1.metadata.checksum);
    });
  });

  describe('Sequence Tracking', () => {
    it('should track sequence numbers per resource', async () => {
      const e1 = await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      const e2 = await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      const e3 = await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      expect(e1.metadata.sequenceNumber).toBe(1);
      expect(e2.metadata.sequenceNumber).toBe(2);
      expect(e3.metadata.sequenceNumber).toBe(3);
    });

    it('should track separate sequences for different resources', async () => {
      const doc1e1 = await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      const doc2e1 = await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc2'),
        version: 1,
        payload: {},
      }, 'doc2');

      const doc1e2 = await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      expect(doc1e1.metadata.sequenceNumber).toBe(1);
      expect(doc2e1.metadata.sequenceNumber).toBe(1);
      expect(doc1e2.metadata.sequenceNumber).toBe(2);
    });

    it('should restore sequence number from existing events', async () => {
      // Append 2 events
      await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      // Create new storage instance (simulates restart)
      const newStorage = new EventStorage({
        basePath: testDir,
        dataDir: testDir,
        enableSharding: true,
        maxEventsPerFile: 3,
        numShards: 256,
      });

      // Initialize should load sequence from disk
      await newStorage.initializeResourceStream('doc1');
      expect(newStorage.getSequenceNumber('doc1')).toBe(2);

      // Next event should be sequence 3
      const e3 = await newStorage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      expect(e3.metadata.sequenceNumber).toBe(3);
    });
  });

  describe('Sharding', () => {
    it('should calculate shard path for resource IDs', () => {
      const path1 = storage.getShardPath('doc-abc123');
      expect(path1).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}$/);
    });

    it('should create consistent shard paths for same resource', () => {
      const path1 = storage.getShardPath('doc-test123');
      const path2 = storage.getShardPath('doc-test123');
      expect(path1).toBe(path2);
    });

    it('should bypass sharding for __system__ events', () => {
      const path = storage.getShardPath('__system__');
      expect(path).toBe('');
    });

    it('should bypass sharding when disabled', () => {
      const noShardStorage = new EventStorage({
        basePath: testDir,
        dataDir: testDir,
        enableSharding: false,
      });

      const path = noShardStorage.getShardPath('doc-test123');
      expect(path).toBe('');
    });

    it('should store events in correct shard directory', async () => {
      await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      const shardPath = storage.getShardPath('doc1');
      const docPath = join(testDir, 'events', shardPath, 'doc1');

      const exists = await fs.access(docPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('File Rotation', () => {
    it('should rotate to new file when maxEventsPerFile exceeded', async () => {
      // maxEventsPerFile = 3 in setup
      await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      // 4th event should trigger rotation
      await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      const files = await storage.getEventFiles('doc1');
      expect(files).toHaveLength(2);
      expect(files[0]).toBe('events-000001.jsonl');
      expect(files[1]).toBe('events-000002.jsonl');
    });

    it('should read events from multiple files', async () => {
      // Add 5 events (will span 2 files with maxEventsPerFile=3)
      for (let i = 0; i < 5; i++) {
        await storage.appendEvent({
          type: 'annotation.added',
          userId: userId('user1'),
          resourceId: resourceId('doc1'),
          version: 1,
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              type: 'Annotation' as const,
              id: `anno-${i}`,
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              body: []
            }
          },
        }, 'doc1');
      }

      const allEvents = await storage.getAllEvents('doc1');
      expect(allEvents).toHaveLength(5);
      expect(allEvents[0]?.metadata.sequenceNumber).toBe(1);
      expect(allEvents[4]?.metadata.sequenceNumber).toBe(5);
    });

    it('should maintain event order across files', async () => {
      // Add 7 events (will span 3 files)
      for (let i = 0; i < 7; i++) {
        await storage.appendEvent({
          type: 'annotation.added',
          userId: userId('user1'),
          resourceId: resourceId('doc1'),
          version: 1,
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              type: 'Annotation' as const,
              id: `anno-${i}`,
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              body: []
            }
          },
        }, 'doc1');
      }

      const allEvents = await storage.getAllEvents('doc1');
      expect(allEvents.map(e => e.metadata.sequenceNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });

  describe('System Events', () => {
    it('should store __system__ events in dedicated directory', async () => {
      await storage.appendEvent({
        type: 'entitytype.added',
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'Person' },
      }, '__system__');

      const systemPath = join(testDir, 'events', '__system__');
      const exists = await fs.access(systemPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should track sequence for __system__ events', async () => {
      const e1 = await storage.appendEvent({
        type: 'entitytype.added',
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'Person' },
      }, '__system__');

      const e2 = await storage.appendEvent({
        type: 'entitytype.added',
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'Organization' },
      }, '__system__');

      expect(e1.metadata.sequenceNumber).toBe(1);
      expect(e2.metadata.sequenceNumber).toBe(2);
    });

    it('should retrieve all __system__ events', async () => {
      await storage.appendEvent({
        type: 'entitytype.added',
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'Person' },
      }, '__system__');

      await storage.appendEvent({
        type: 'entitytype.added',
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'Organization' },
      }, '__system__');

      const events = await storage.getAllEvents('__system__');
      expect(events).toHaveLength(2);
      expect(events[0]?.event.type).toBe('entitytype.added');
    });
  });

  describe('Read Operations', () => {
    beforeEach(async () => {
      // Add some test events
      await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: { name: 'Doc1', format: 'text/plain' as const, contentChecksum: 'checksum1', creationMethod: 'api' as const },
      }, 'doc1');

      await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            type: 'Annotation' as const,
            id: 'anno1',
            motivation: 'highlighting' as const,
            target: { source: 'doc1' },
            body: []
          }
        },
      }, 'doc1');

      await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc2'),
        version: 1,
        payload: { name: 'Doc2', format: 'text/plain' as const, contentChecksum: 'checksum2', creationMethod: 'api' as const },
      }, 'doc2');
    });

    it('should get all events for resource', async () => {
      const events = await storage.getAllEvents('doc1');
      expect(events).toHaveLength(2);
      expect(events[0]?.event.type).toBe('resource.created');
      expect(events[1]?.event.type).toBe('annotation.added');
    });

    it('should return empty array for nonexistent resource', async () => {
      const events = await storage.getAllEvents('doc-nonexistent');
      expect(events).toEqual([]);
    });

    it('should get event files in order', async () => {
      const files = await storage.getEventFiles('doc1');
      expect(files).toEqual(['events-000001.jsonl']);
    });

    it('should count events in file', async () => {
      const count = await storage.countEventsInFile('doc1', 'events-000001.jsonl');
      expect(count).toBe(2);
    });

    it('should get last event from file', async () => {
      const last = await storage.getLastEvent('doc1', 'events-000001.jsonl');
      expect(last).not.toBeNull();
      expect(last?.event.type).toBe('annotation.added');
      expect(last?.metadata.sequenceNumber).toBe(2);
    });

    it('should return null for last event of empty file', async () => {
      // Create empty file
      const docPath = storage.getResourcePath('doc-empty');
      await fs.mkdir(docPath, { recursive: true });
      await fs.writeFile(join(docPath, 'events-000001.jsonl'), '', 'utf-8');

      const last = await storage.getLastEvent('doc-empty', 'events-000001.jsonl');
      expect(last).toBeNull();
    });

    it('should get all resource IDs', async () => {
      const ids = await storage.getAllResourceIds();
      expect(ids).toContain('doc1');
      expect(ids).toContain('doc2');
      expect(ids.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('JSONL Format', () => {
    it('should write valid JSONL (one object per line)', async () => {
      await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      await storage.appendEvent({
        type: 'annotation.added',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      const docPath = storage.getResourcePath('doc1');
      const content = await fs.readFile(join(docPath, 'events-000001.jsonl'), 'utf-8');

      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      // Each line should be valid JSON
      const json1 = JSON.parse(lines[0]!);
      const json2 = JSON.parse(lines[1]!);

      expect(json1.event).toBeDefined();
      expect(json1.metadata).toBeDefined();
      expect(json2.event).toBeDefined();
      expect(json2.metadata).toBeDefined();
    });

    it('should handle empty lines gracefully', async () => {
      await storage.appendEvent({
        type: 'resource.created',
        userId: userId('user1'),
        resourceId: resourceId('doc1'),
        version: 1,
        payload: {},
      }, 'doc1');

      // Manually add empty line
      const docPath = storage.getResourcePath('doc1');
      await fs.appendFile(join(docPath, 'events-000001.jsonl'), '\n\n', 'utf-8');

      // Should still read correctly
      const events = await storage.getAllEvents('doc1');
      expect(events).toHaveLength(1);
    });
  });
});
