/**
 * Resource Operations Tests
 *
 * Tests critical business logic for resource CRUD operations including:
 * - Resource creation (via Stower)
 * - Resource updates (archive/unarchive, entity type tagging)
 * - Event emission for all state changes
 *
 * Uses a real EventBus + Stower + EventStore pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ResourceOperations } from '../resource-operations';
import { type SemiontProject } from '@semiont/core/node';
import { userId, EventBus, CREATION_METHODS, type Logger, type GraphServiceConfig } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { Stower } from '../stower';
import { createKnowledgeBase } from '../knowledge-base';
import { getGraphDatabase } from '@semiont/graph';
import { deriveStorageUri } from '@semiont/content';
import type { KnowledgeBase } from '../knowledge-base';
import { createTestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

let fileCounter = 0;

describe('ResourceOperations', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let testEventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let kb: KnowledgeBase;

  /** Write content to disk then create resource via EventBus. */
  async function create(
    opts: { name: string; content: Buffer; format: 'text/plain' | 'text/markdown' | 'text/html'; language?: string; entityTypes?: string[]; creationMethod?: import('@semiont/core').CreationMethod },
    uid: import('@semiont/core').UserId,
  ) {
    const uri = deriveStorageUri(`test-${++fileCounter}`, opts.format);
    const stored = await kb.content.store(opts.content, uri);
    return ResourceOperations.createResource(
      { name: opts.name, storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format: opts.format, language: opts.language, entityTypes: opts.entityTypes, creationMethod: opts.creationMethod },
      uid,
      eventBus,
    );
  }

  beforeAll(async () => {
    ({ project, teardown } = await createTestProject('resource-ops'));

    eventBus = new EventBus();
    testEventStore = createEventStore(project, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    kb = await createKnowledgeBase(testEventStore, project, graphDb, eventBus, mockLogger);

    stower = new Stower(kb, eventBus, mockLogger);
    await stower.initialize();
  });

  afterAll(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('createResource', () => {
    it('should create resource with valid text content', async () => {
      const resId = await create(
        { name: 'Test Resource', content: Buffer.from('Test resource content', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      expect(resId).toBeDefined();

      // Verify via event store
      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.name).toBe('Test Resource');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.format).toBe('text/plain');
    });

    it('should generate resource ID', async () => {
      const resId = await create(
        { name: 'Resource with ID', content: Buffer.from('Another test', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      expect(resId).toBeDefined();
      expect(typeof resId).toBe('string');
      expect(resId.length).toBeGreaterThan(0);
    });

    it('should store representation', async () => {
      const resId = await create(
        { name: 'Stored Resource', content: Buffer.from('Content to store', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      expect(resId).toBeDefined();
    });

    it('should emit resource.created event', async () => {
      const resId = await create(
        { name: 'Event Test Resource', content: Buffer.from('Event test content', 'utf-8'), format: 'text/plain', entityTypes: ['Person', 'Location'] },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvents = events.filter(e => e.type === 'yield:created');
      expect(createdEvents).toHaveLength(1);

      const createdEvent = createdEvents[0];
      expect(createdEvent).toMatchObject({
        type: 'yield:created',
        resourceId: resId,
        userId: userId('user-1'),
        payload: {
          name: 'Event Test Resource',
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
          creationMethod: CREATION_METHODS.API,
          isDraft: false,
        }
      });
    });

    it('should handle markdown content format', async () => {
      const resId = await create(
        { name: 'Markdown Resource', content: Buffer.from('# Markdown Title\n\nParagraph content', 'utf-8'), format: 'text/markdown' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.format).toBe('text/markdown');
    });

    it('should handle html content format', async () => {
      const resId = await create(
        { name: 'HTML Resource', content: Buffer.from('<html><body>HTML content</body></html>', 'utf-8'), format: 'text/html' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.format).toBe('text/html');
    });

    it('should handle optional language parameter', async () => {
      const resId = await create(
        { name: 'French Resource', content: Buffer.from('Contenu en français', 'utf-8'), format: 'text/plain', language: 'fr' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.language).toBe('fr');
    });

    it('should handle optional entity types', async () => {
      const resId = await create(
        { name: 'Entity Resource', content: Buffer.from('Content with entities', 'utf-8'), format: 'text/plain', entityTypes: ['Person', 'Organization', 'Location'] },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.entityTypes).toEqual(['Person', 'Organization', 'Location']);
    });

    it('should handle empty entity types array', async () => {
      const resId = await create(
        { name: 'No Entities Resource', content: Buffer.from('No entities', 'utf-8'), format: 'text/plain', entityTypes: [] },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.entityTypes).toEqual([]);
    });

    it('should default to API creation method when not specified', async () => {
      const resId = await create(
        { name: 'Default Method Resource', content: Buffer.from('Default creation method', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.creationMethod).toBe(CREATION_METHODS.API);
    });

    it('should accept valid creation method', async () => {
      const resId = await create(
        { name: 'Generated Resource', content: Buffer.from('Generated content', 'utf-8'), format: 'text/plain', creationMethod: CREATION_METHODS.GENERATED },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.creationMethod).toBe(CREATION_METHODS.GENERATED);
    });

    it('should include timestamp in event', async () => {
      const resId = await create(
        { name: 'Timestamped Resource', content: Buffer.from('Timestamped content', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.timestamp).toBeDefined();
      expect(new Date(createdEvent!.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('should forward generation-provenance fields through to the persisted yield:created event', async () => {
      // Protects the generation-worker flow: the worker (via POST /resources)
      // passes generatedFrom / generationPrompt / generator / isDraft through
      // ResourceOperations.createResource. If any field is dropped on the floor
      // here, downstream readers (graph materializer, PROV-O query) silently
      // lose provenance with no runtime error.
      const generator = {
        '@type': 'SoftwareAgent' as const,
        name: 'worker-pool / ollama gemma4:26b',
        worker: 'worker-pool',
        inferenceProvider: 'ollama',
        model: 'gemma4:26b',
      };
      const uri = deriveStorageUri(`test-${++fileCounter}`, 'text/markdown');
      const stored = await kb.content.store(Buffer.from('# Generated\n', 'utf-8'), uri);
      const resId = await ResourceOperations.createResource(
        {
          name: 'Generated Doc',
          storageUri: stored.storageUri,
          contentChecksum: stored.checksum,
          byteSize: stored.byteSize,
          format: 'text/markdown',
          creationMethod: CREATION_METHODS.GENERATED,
          generatedFrom: { resourceId: 'res-parent', annotationId: 'ann-origin' },
          generationPrompt: 'Summarize the key points',
          generator,
          isDraft: true,
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      if (createdEvent && createdEvent.type === 'yield:created') {
        expect(createdEvent.payload).toMatchObject({
          name: 'Generated Doc',
          format: 'text/markdown',
          creationMethod: CREATION_METHODS.GENERATED,
          generatedFrom: { resourceId: 'res-parent', annotationId: 'ann-origin' },
          generationPrompt: 'Summarize the key points',
          generator,
          isDraft: true,
        });
      }
    });

    it('should omit generatedFrom from persisted event when only one side of the edge is provided', async () => {
      // Stower requires BOTH resourceId and annotationId to persist
      // generatedFrom (see handleYieldCreate). If only one is present
      // the field is dropped rather than persisted in a half-shape that
      // downstream code can't reason about. Pinning this behavior so a
      // future refactor doesn't silently relax it.
      const uri = deriveStorageUri(`test-${++fileCounter}`, 'text/plain');
      const stored = await kb.content.store(Buffer.from('partial', 'utf-8'), uri);
      const resId = await ResourceOperations.createResource(
        {
          name: 'Half-provenance Doc',
          storageUri: stored.storageUri,
          contentChecksum: stored.checksum,
          byteSize: stored.byteSize,
          format: 'text/plain',
          generatedFrom: { resourceId: 'res-only' }, // no annotationId
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      if (createdEvent && createdEvent.type === 'yield:created') {
        expect(createdEvent.payload.generatedFrom).toBeUndefined();
      }
    });
  });
});
