/**
 * Event Store Tests - Fast, Essential Coverage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventStore } from '../../events/event-store';
import { EventQuery } from '../../events/query/event-query';
import { EventValidator } from '../../events/validation/event-validator';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import { CREATION_METHODS } from '@semiont/core';
import { resourceId, userId } from '@semiont/core';
import type { IdentifierConfig } from '../../services/identifier-service';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Event Store', () => {
  let testDir: string;
  let eventStore: EventStore;
  let query: EventQuery;
  let validator: EventValidator;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const projectionStorage = new FilesystemProjectionStorage(testDir);
    const identifierConfig: IdentifierConfig = { baseUrl: 'http://localhost:4000' };

    eventStore = new EventStore(
      {
        basePath: testDir,
        dataDir: testDir,
        enableSharding: false, // Faster without sharding
        maxEventsPerFile: 100,
      },
      projectionStorage,
      identifierConfig
    );

    query = new EventQuery(eventStore.log.storage);
    validator = new EventValidator();
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should emit and retrieve events', async () => {
    const docId = resourceId('doc-test1');

    const event1 = await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: {
        name: 'Test',
        format: 'text/plain',
        contentChecksum: 'hash1',
        creationMethod: CREATION_METHODS.API,
      },
    });

    expect(event1.metadata.sequenceNumber).toBe(1);

    const events = await query.getResourceEvents(docId);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe('resource.created');
  });

  it('should create event chain with prevEventHash', async () => {
    const docId = resourceId('doc-test2');

    const e1 = await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
    });

    const e2 = await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
          'type': 'Annotation' as const,
          id: 'hl1',
          motivation: 'highlighting' as const,
          target: {
            source: docId,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 0,
                end: 4,
              },
              {
                type: 'TextQuoteSelector',
                exact: 'Test',
              },
            ],
          },
          body: [], // Empty body array (no entity tags)
          modified: new Date().toISOString(),
        },
      },
    });

    expect(e1.metadata.prevEventHash).toBeUndefined();
    expect(e2.metadata.prevEventHash).toBe(e1.metadata.checksum);

    const eventsForValidation = await query.getResourceEvents(docId);
    const validation = validator.validateEventChain(eventsForValidation);
    expect(validation.valid).toBe(true);
  });

  it('should rebuild projection from events', async () => {
    const docId = resourceId('doc-test3');

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: { name: 'Doc', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
    });

    await eventStore.appendEvent({
      type: 'entitytag.added',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: { entityType: 'note' },
    });

    const events = await query.getResourceEvents(docId);
    const stored = await eventStore.projections.projector.projectResource(events, docId);

    expect(stored).toBeDefined();
    expect(stored!.resource.name).toBe('Doc');
    // Note: content is NOT in projections - must be loaded from filesystem separately
    expect(stored!.resource.entityTypes).toContain('note');
    expect(stored!.annotations.version).toBe(2);
  });
});