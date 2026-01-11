/**
 * GraphDB Consumer Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { GraphDBConsumer } from '../../events/consumers/graph-consumer';
import type { StoredEvent, ResourceEvent, ResourceCreatedEvent, ResourceClonedEvent } from '@semiont/core';
import { resourceId, userId, annotationId } from '@semiont/core';
import { CREATION_METHODS } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';

// Mock GraphDB
const createMockGraphDB = (): GraphDatabase => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),

  createResource: vi.fn().mockResolvedValue({
    id: 'doc-123',
    name: 'Test Doc',
    entityTypes: [],
    format: 'text/plain',
    contentChecksum: 'hash123',
    metadata: {},
    creator: {
      id: 'user1',
      type: 'Person',
      name: 'user1',
    },
    created: new Date(),
  }),
  getResource: vi.fn().mockResolvedValue({
    id: 'doc-123',
    name: 'Test Doc',
    entityTypes: ['entity1'],
    archived: false,
  }),
  updateResource: vi.fn().mockResolvedValue({
    id: 'doc-123',
    name: 'Test Doc',
    entityTypes: ['entity1'],
    archived: true,
  }),
  deleteResource: vi.fn().mockResolvedValue(undefined),
  listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
  searchResources: vi.fn().mockResolvedValue([]),

  createAnnotation: vi.fn().mockResolvedValue({
    id: 'sel-123',
    resourceId: resourceId('doc-123'),
    exact: 'test',
    selector: { type: 'text_span', offset: 0, length: 4 },
    type: 'TextualBody',
    creator: 'user1',
    created: new Date().toISOString(),
    entityTypes: [],
  }),
  getAnnotation: vi.fn().mockResolvedValue(null),
  updateAnnotation: vi.fn().mockResolvedValue({
    id: 'sel-123',
    resourceId: resourceId('doc-123'),
    exact: 'test',
    selector: { type: 'text_span', offset: 0, length: 4 },
    type: 'SpecificResource',
    source: 'doc-456',
    creator: 'user1',
    created: new Date().toISOString(),
    entityTypes: [],
  }),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  listAnnotations: vi.fn().mockResolvedValue({ annotations: [], total: 0 }),

  getHighlights: vi.fn().mockResolvedValue([]),
  resolveReference: vi.fn().mockResolvedValue({
    id: 'sel-123',
    resourceId: resourceId('doc-123'),
    exact: 'test',
    selector: { type: 'text_span', offset: 0, length: 4 },
    type: 'SpecificResource',
    source: 'doc-456',
    creator: 'user1',
    created: new Date(),
    entityTypes: [],
  }),
  getReferences: vi.fn().mockResolvedValue([]),
  getEntityReferences: vi.fn().mockResolvedValue([]),

  getResourceAnnotations: vi.fn().mockResolvedValue([]),
  getResourceReferencedBy: vi.fn().mockResolvedValue([]),

  getResourceConnections: vi.fn().mockResolvedValue([]),
  findPath: vi.fn().mockResolvedValue([]),

  getEntityTypeStats: vi.fn().mockResolvedValue([]),
  getStats: vi.fn().mockResolvedValue({
    resourceCount: 0,
    selectionCount: 0,
    highlightCount: 0,
    referenceCount: 0,
    entityReferenceCount: 0,
    entityTypes: {},
    contentTypes: {},
  }),

  createAnnotations: vi.fn().mockResolvedValue([]),
  resolveReferences: vi.fn().mockResolvedValue([]),

  detectAnnotations: vi.fn().mockResolvedValue([]),

  getEntityTypes: vi.fn().mockResolvedValue([]),
  addEntityType: vi.fn().mockResolvedValue(undefined),
  addEntityTypes: vi.fn().mockResolvedValue(undefined),

  generateId: vi.fn().mockReturnValue('generated-id'),
  clearDatabase: vi.fn().mockResolvedValue(undefined),
});

// Note: GraphDB consumer no longer accesses content/representations directly
// Content is stored separately in RepresentationStore

describe('GraphDBConsumer', () => {
  let consumer: GraphDBConsumer;
  let mockGraphDB: GraphDatabase;
  let testEnv: TestEnvironmentConfig;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(async () => {
    mockGraphDB = createMockGraphDB();
    consumer = new GraphDBConsumer(testEnv.config);

    // Inject mock GraphDB
    consumer['graphDb'] = mockGraphDB;
  });

  afterEach(async () => {
    await consumer.shutdown();
  });

  describe('resource.created event', () => {
    it('should create resource in GraphDB', async () => {
      const event: ResourceCreatedEvent = {
        id: 'evt-1',
        type: 'resource.created',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          name: 'Test Resource',
          format: 'text/plain',
          contentChecksum: 'hash123',
          creationMethod: CREATION_METHODS.API,
          entityTypes: ['entity1', 'entity2'],
          language: 'en',
          isDraft: false,
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 1,
          streamPosition: 0,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.createResource).toHaveBeenCalledWith({
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/doc-123',
        name: 'Test Resource',
        entityTypes: ['entity1', 'entity2'],
        representations: [{
          mediaType: 'text/plain',
          checksum: 'hash123',
          rel: 'original',
        }],
        archived: false,
        dateCreated: expect.any(String),
        wasAttributedTo: {
          id: 'user1',
          type: 'Person',
          name: 'user1',
        },
        creationMethod: 'api',
      });
    });

    it('should handle missing optional fields', async () => {
      const event: ResourceEvent = {
        id: 'evt-1',
        type: 'resource.created',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          name: 'Test Resource',
          format: 'text/plain',
          contentChecksum: 'hash123',
          creationMethod: CREATION_METHODS.API,
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 1,
          streamPosition: 0,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.createResource).toHaveBeenCalledWith({
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/doc-123',
        name: 'Test Resource',
        entityTypes: [],
        representations: [{
          mediaType: 'text/plain',
          checksum: 'hash123',
          rel: 'original',
        }],
        archived: false,
        dateCreated: expect.any(String),
        wasAttributedTo: {
          id: 'user1',
          type: 'Person',
          name: 'user1',
        },
        creationMethod: 'api',
      });
    });
  });

  describe('resource.cloned event', () => {
    it('should create cloned resource in GraphDB', async () => {
      const event: ResourceClonedEvent = {
        id: 'evt-2',
        type: 'resource.cloned',
        resourceId: resourceId('doc-456'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          name: 'Cloned Resource',
          format: 'text/plain',
          contentChecksum: 'hash456',
          parentResourceId: 'doc-123',
          creationMethod: CREATION_METHODS.CLONE,
          entityTypes: ['entity1'],
          language: 'en',
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 1,
          streamPosition: 0,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.createResource).toHaveBeenCalledWith({
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/doc-456',
        name: 'Cloned Resource',
        entityTypes: ['entity1'],
        representations: [{
          mediaType: 'text/plain',
          checksum: 'hash456',
          rel: 'original',
        }],
        archived: false,
        dateCreated: expect.any(String),
        wasAttributedTo: {
          id: 'user1',
          type: 'Person',
          name: 'user1',
        },
        creationMethod: 'clone',
      });
    });
  });

  describe('resource.archived event', () => {
    it('should archive resource in GraphDB', async () => {
      const event: ResourceEvent = {
        id: 'evt-3',
        type: 'resource.archived',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: { reason: 'test' },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 2,
          streamPosition: 100,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.updateResource).toHaveBeenCalledWith('http://localhost:4000/resources/doc-123', {
        archived: true,
      });
    });
  });

  describe('resource.unarchived event', () => {
    it('should unarchive resource in GraphDB', async () => {
      const event: ResourceEvent = {
        id: 'evt-4',
        type: 'resource.unarchived',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {},
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 3,
          streamPosition: 200,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.updateResource).toHaveBeenCalledWith('http://localhost:4000/resources/doc-123', {
        archived: false,
      });
    });
  });

  describe('annotation.added event (highlighting)', () => {
    it('should create highlighting annotation with entity tags in GraphDB', async () => {
      const event: ResourceEvent = {
        id: 'evt-5',
        type: 'annotation.added',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            'type': 'Annotation' as const,
            id: 'hl-123',
            motivation: 'highlighting' as const,
            target: {
              source: 'doc-123',
              selector: [
                {
                  type: 'TextPositionSelector',
                  start: 10,
                  end: 24,
                },
                {
                  type: 'TextQuoteSelector',
                  exact: 'important text',
                },
              ],
            },
            body: [
              { type: 'TextualBody' as const, value: 'TechnicalTerm', purpose: 'tagging' as const },
              { type: 'TextualBody' as const, value: 'ImportantConcept', purpose: 'tagging' as const },
            ],
            modified: new Date().toISOString(),
          },
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 4,
          streamPosition: 300,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
        id: 'hl-123',
        motivation: 'highlighting',
        target: {
          source: 'doc-123',
          selector: [
            {
              type: 'TextPositionSelector',
              start: 10,
              end: 24,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'important text',
            },
          ],
        },
        body: [
          { type: 'TextualBody', value: 'TechnicalTerm', purpose: 'tagging' },
          { type: 'TextualBody', value: 'ImportantConcept', purpose: 'tagging' },
        ],
        creator: {
          type: 'Person',
          id: 'user1',
          name: 'user1',
        },
      }));
    });
  });

  describe('annotation.removed event', () => {
    it('should delete annotation from GraphDB', async () => {
      const event: ResourceEvent = {
        id: 'evt-6',
        type: 'annotation.removed',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          annotationId: annotationId('hl-123'),
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 5,
          streamPosition: 400,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.deleteAnnotation).toHaveBeenCalledWith('http://localhost:4000/annotations/hl-123');
    });
  });

  describe('annotation.added event (linking)', () => {
    it('should create resolved linking annotation with entity tags in GraphDB', async () => {
      const event: ResourceEvent = {
        id: 'evt-7',
        type: 'annotation.added',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            'type': 'Annotation' as const,
            id: 'ref-123',
            motivation: 'linking' as const,
            target: {
              source: 'doc-123',
              selector: [
                {
                  type: 'TextPositionSelector',
                  start: 20,
                  end: 34,
                },
                {
                  type: 'TextQuoteSelector',
                  exact: 'reference text',
                },
              ],
            },
            body: [
              { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const },
              { type: 'TextualBody' as const, value: 'Organization', purpose: 'tagging' as const },
              { type: 'SpecificResource' as const, source: 'doc-456', purpose: 'linking' as const },
            ],
            modified: new Date().toISOString(),
          },
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 6,
          streamPosition: 500,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ref-123',
        motivation: 'linking',
        target: {
          source: 'doc-123',
          selector: [
            {
              type: 'TextPositionSelector',
              start: 20,
              end: 34,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'reference text',
            },
          ],
        },
        body: [
          { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
          { type: 'TextualBody', value: 'Organization', purpose: 'tagging' },
          { type: 'SpecificResource', source: 'doc-456', purpose: 'linking' },
        ],
        creator: {
          type: 'Person',
          id: 'user1',
          name: 'user1',
        },
      }));
    });

    it('should create stub linking annotation with entity tags', async () => {
      const event: ResourceEvent = {
        id: 'evt-8',
        type: 'annotation.added',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            'type': 'Annotation' as const,
            id: 'ref-456',
            motivation: 'linking' as const,
            target: {
              source: 'doc-123',
              selector: [
                {
                  type: 'TextPositionSelector',
                  start: 30,
                  end: 44,
                },
                {
                  type: 'TextQuoteSelector',
                  exact: 'stub reference',
                },
              ],
            },
            body: [
              { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const },
              { type: 'TextualBody' as const, value: 'Scientist', purpose: 'tagging' as const },
            ],
            modified: new Date().toISOString(),
          },
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 7,
          streamPosition: 600,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ref-456',
        motivation: 'linking',
        target: {
          source: 'doc-123',
          selector: [
            {
              type: 'TextPositionSelector',
              start: 30,
              end: 44,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'stub reference',
            },
          ],
        },
        body: [
          { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
          { type: 'TextualBody', value: 'Scientist', purpose: 'tagging' },
        ],
        creator: {
          type: 'Person',
          id: 'user1',
          name: 'user1',
        },
      }));
    });
  });

  describe('annotation.body.updated event', () => {
    it('should add SpecificResource to annotation body in GraphDB', async () => {
      // Mock getAnnotation to return an annotation with existing body
      (mockGraphDB.getAnnotation as any).mockResolvedValueOnce({
        id: 'ref-456',
        type: 'Annotation',
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        motivation: 'linking',
        target: { source: 'doc-123' },
        body: [
          { type: 'TextualBody', value: 'Entity1', purpose: 'tagging' }
        ],
        creator: { id: 'user1', type: 'Person' },
        created: new Date().toISOString(),
      });

      const event: ResourceEvent = {
        id: 'evt-9',
        type: 'annotation.body.updated',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          annotationId: annotationId('ref-456'),
          operations: [{
            op: 'add',
            item: {
              type: 'SpecificResource',
              source: 'doc-789',
              purpose: 'linking',
            },
          }],
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 8,
          streamPosition: 700,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      // Should update annotation with both TextualBody and SpecificResource
      expect(mockGraphDB.updateAnnotation).toHaveBeenCalledWith('http://localhost:4000/annotations/ref-456', {
        body: [
          { type: 'TextualBody', value: 'Entity1', purpose: 'tagging' },
          { type: 'SpecificResource', source: 'doc-789', purpose: 'linking' },
        ],
      });
    });
  });

  describe('annotation.removed event (linking)', () => {
    it('should delete linking annotation from GraphDB', async () => {
      const event: ResourceEvent = {
        id: 'evt-10',
        type: 'annotation.removed',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          annotationId: annotationId('ref-123'),
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 9,
          streamPosition: 800,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.deleteAnnotation).toHaveBeenCalledWith('http://localhost:4000/annotations/ref-123');
    });
  });

  describe('entitytag.added event', () => {
    it('should add entity tag to resource', async () => {
      const event: ResourceEvent = {
        id: 'evt-11',
        type: 'entitytag.added',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          entityType: 'NewEntity',
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 10,
          streamPosition: 900,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.getResource).toHaveBeenCalledWith('http://localhost:4000/resources/doc-123');
      expect(mockGraphDB.updateResource).toHaveBeenCalledWith('http://localhost:4000/resources/doc-123', {
        entityTypes: ['entity1', 'NewEntity'],
      });
    });
  });

  describe('entitytag.removed event', () => {
    it('should remove entity tag from resource', async () => {
      const event: ResourceEvent = {
        id: 'evt-12',
        type: 'entitytag.removed',
        resourceId: resourceId('doc-123'),
        userId: userId('user1'),
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          entityType: 'entity1',
        },
      };

      const storedEvent: StoredEvent = {
        event,
        metadata: {
          sequenceNumber: 11,
          streamPosition: 1000,
          timestamp: new Date().toISOString(),
        },
      };

      await consumer['applyEventToGraph'](storedEvent);

      expect(mockGraphDB.getResource).toHaveBeenCalledWith('http://localhost:4000/resources/doc-123');
      expect(mockGraphDB.updateResource).toHaveBeenCalledWith('http://localhost:4000/resources/doc-123', {
        entityTypes: [],
      });
    });
  });

  describe('health metrics', () => {
    it('should report health metrics', () => {
      const metrics = consumer.getHealthMetrics();

      expect(metrics).toHaveProperty('subscriptions');
      expect(metrics).toHaveProperty('lastProcessed');
      expect(metrics).toHaveProperty('processing');
      expect(typeof metrics.subscriptions).toBe('number');
    });
  });
});