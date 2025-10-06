/**
 * Event Store Tests - Fast, Essential Coverage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventStore } from '../../events/event-store';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Event Store', () => {
  let testDir: string;
  let eventStore: EventStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const projectionStorage = new FilesystemProjectionStorage(testDir);

    eventStore = new EventStore({
      dataDir: testDir,
      enableSharding: false, // Faster without sharding
      maxEventsPerFile: 100,
    }, projectionStorage);

    await eventStore.initialize();
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should emit and retrieve events', async () => {
    const docId = 'doc-test1';

    const event1 = await eventStore.appendEvent({
      type: 'document.created',
      documentId: docId,
      userId: 'user1',
      version: 1,
      payload: {
        name: 'Test',
        contentType: 'text/plain',
        contentHash: 'hash1',
      },
    });

    expect(event1.metadata.sequenceNumber).toBe(1);

    const events = await eventStore.getDocumentEvents(docId);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe('document.created');
  });

  it('should create event chain with prevEventHash', async () => {
    const docId = 'doc-test2';

    const e1 = await eventStore.appendEvent({
      type: 'document.created',
      documentId: docId,
      userId: 'user1',
      version: 1,
      payload: { name: 'Test', contentType: 'text/plain', contentHash: 'h1' },
    });

    const e2 = await eventStore.appendEvent({
      type: 'highlight.added',
      documentId: docId,
      userId: 'user1',
      version: 1,
      payload: { highlightId: 'hl1', exact: 'Test', position: { offset: 0, length: 4 } },
    });

    expect(e1.metadata.prevEventHash).toBeUndefined();
    expect(e2.metadata.prevEventHash).toBe(e1.metadata.checksum);

    const validation = await eventStore.validateEventChain(docId);
    expect(validation.valid).toBe(true);
  });

  it('should rebuild projection from events', async () => {
    const docId = 'doc-test3';

    await eventStore.appendEvent({
      type: 'document.created',
      documentId: docId,
      userId: 'user1',
      version: 1,
      payload: { name: 'Doc', contentType: 'text/plain', contentHash: 'h1' },
    });

    await eventStore.appendEvent({
      type: 'entitytag.added',
      documentId: docId,
      userId: 'user1',
      version: 1,
      payload: { entityType: 'note' },
    });

    const projection = await eventStore.projectDocument(docId);

    expect(projection).toBeDefined();
    expect(projection!.name).toBe('Doc');
    // Note: content is NOT in projections - must be loaded from filesystem separately
    expect(projection!.entityTypes).toContain('note');
    expect(projection!.version).toBe(2);
  });
});