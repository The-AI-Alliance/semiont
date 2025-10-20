/**
 * GraphDB Consumer Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphDBConsumer } from '../../events/consumers/graph-consumer';
import type { StoredEvent, DocumentEvent, DocumentCreatedEvent, DocumentClonedEvent } from '@semiont/core';
import { CREATION_METHODS } from '@semiont/core';
import type { GraphDatabase } from '../../graph/interface';

// Mock GraphDB
const createMockGraphDB = (): GraphDatabase => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),

  createDocument: vi.fn().mockResolvedValue({
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
  getDocument: vi.fn().mockResolvedValue({
    id: 'doc-123',
    name: 'Test Doc',
    entityTypes: ['entity1'],
    archived: false,
  }),
  updateDocument: vi.fn().mockResolvedValue({
    id: 'doc-123',
    name: 'Test Doc',
    entityTypes: ['entity1'],
    archived: true,
  }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  listDocuments: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
  searchDocuments: vi.fn().mockResolvedValue([]),

  createAnnotation: vi.fn().mockResolvedValue({
    id: 'sel-123',
    documentId: 'doc-123',
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
    documentId: 'doc-123',
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
    documentId: 'doc-123',
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

  getDocumentAnnotations: vi.fn().mockResolvedValue([]),
  getDocumentReferencedBy: vi.fn().mockResolvedValue([]),

  getDocumentConnections: vi.fn().mockResolvedValue([]),
  findPath: vi.fn().mockResolvedValue([]),

  getEntityTypeStats: vi.fn().mockResolvedValue([]),
  getStats: vi.fn().mockResolvedValue({
    documentCount: 0,
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

// Mock storage service
vi.mock('../../storage/filesystem', () => ({
  getStorageService: () => ({
    getDocument: vi.fn().mockResolvedValue(Buffer.from('test content')),
    saveDocument: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('GraphDBConsumer', () => {
  let consumer: GraphDBConsumer;
  let mockGraphDB: GraphDatabase;

  beforeEach(async () => {
    mockGraphDB = createMockGraphDB();
    consumer = new GraphDBConsumer();

    // Inject mock GraphDB
    consumer['graphDb'] = mockGraphDB;
  });

  afterEach(async () => {
    await consumer.shutdown();
  });

  describe('document.created event', () => {
    it('should create document in GraphDB', async () => {
      const event: DocumentCreatedEvent = {
        id: 'evt-1',
        type: 'document.created',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          name: 'Test Document',
          format: 'text/plain',
          contentHash: 'hash123',
          creationMethod: CREATION_METHODS.API,
          entityTypes: ['entity1', 'entity2'],
          locale: 'en',
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

      expect(mockGraphDB.createDocument).toHaveBeenCalledWith({
        id: 'doc-123',
        name: 'Test Document',
        entityTypes: ['entity1', 'entity2'],
        content: 'test content',
        format: 'text/plain',
        contentChecksum: 'hash123',
        creator: {
          id: 'user1',
          type: 'Person',
          name: 'user1',
        },
        creationMethod: 'api',
      });
    });

    it('should handle missing optional fields', async () => {
      const event: DocumentEvent = {
        id: 'evt-1',
        type: 'document.created',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          name: 'Test Document',
          format: 'text/plain',
          contentHash: 'hash123',
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

      expect(mockGraphDB.createDocument).toHaveBeenCalledWith({
        id: 'doc-123',
        name: 'Test Document',
        entityTypes: [],
        content: 'test content',
        format: 'text/plain',
        contentChecksum: 'hash123',
        creator: {
          id: 'user1',
          type: 'Person',
          name: 'user1',
        },
        creationMethod: 'api',
      });
    });
  });

  describe('document.cloned event', () => {
    it('should create cloned document in GraphDB', async () => {
      const event: DocumentClonedEvent = {
        id: 'evt-2',
        type: 'document.cloned',
        documentId: 'doc-456',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          name: 'Cloned Document',
          format: 'text/plain',
          contentHash: 'hash456',
          parentDocumentId: 'doc-123',
          creationMethod: CREATION_METHODS.CLONE,
          entityTypes: ['entity1'],
          locale: 'en',
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

      expect(mockGraphDB.createDocument).toHaveBeenCalledWith({
        id: 'doc-456',
        name: 'Cloned Document',
        entityTypes: ['entity1'],
        content: 'test content',
        format: 'text/plain',
        contentChecksum: 'hash456',
        creator: {
          id: 'user1',
          type: 'Person',
          name: 'user1',
        },
        creationMethod: 'clone',
      });
    });
  });

  describe('document.archived event', () => {
    it('should archive document in GraphDB', async () => {
      const event: DocumentEvent = {
        id: 'evt-3',
        type: 'document.archived',
        documentId: 'doc-123',
        userId: 'user1',
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

      expect(mockGraphDB.updateDocument).toHaveBeenCalledWith('doc-123', {
        archived: true,
      });
    });
  });

  describe('document.unarchived event', () => {
    it('should unarchive document in GraphDB', async () => {
      const event: DocumentEvent = {
        id: 'evt-4',
        type: 'document.unarchived',
        documentId: 'doc-123',
        userId: 'user1',
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

      expect(mockGraphDB.updateDocument).toHaveBeenCalledWith('doc-123', {
        archived: false,
      });
    });
  });

  describe('highlight.added event', () => {
    it('should create highlight in GraphDB', async () => {
      const event: DocumentEvent = {
        id: 'evt-5',
        type: 'highlight.added',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          highlightId: 'hl-123',
          exact: 'important text',
          position: { offset: 10, length: 14 },
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

      expect(mockGraphDB.createAnnotation).toHaveBeenCalledWith({
        id: 'hl-123',
        target: {
          source: 'doc-123',
          selector: {
            type: 'TextPositionSelector',
            exact: 'important text',
            offset: 10,
            length: 14,
          },
        },
        body: {
          type: 'TextualBody',
          entityTypes: [],
        },
        creator: {
          type: 'Person',
          id: 'user1',
          name: 'user1',
        },
      });
    });
  });

  describe('highlight.removed event', () => {
    it('should delete highlight from GraphDB', async () => {
      const event: DocumentEvent = {
        id: 'evt-6',
        type: 'highlight.removed',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          highlightId: 'hl-123',
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

      expect(mockGraphDB.deleteAnnotation).toHaveBeenCalledWith('hl-123');
    });
  });

  describe('reference.created event', () => {
    it('should create reference in GraphDB', async () => {
      const event: DocumentEvent = {
        id: 'evt-7',
        type: 'reference.created',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          referenceId: 'ref-123',
          exact: 'reference text',
          position: { offset: 20, length: 14 },
          entityTypes: ['Person', 'Organization'],
          targetDocumentId: 'doc-456',
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

      expect(mockGraphDB.createAnnotation).toHaveBeenCalledWith({
        id: 'ref-123',
        target: {
          source: 'doc-123',
          selector: {
            type: 'TextPositionSelector',
            exact: 'reference text',
            offset: 20,
            length: 14,
          },
        },
        body: {
          type: 'SpecificResource',
          source: 'doc-456',
          entityTypes: ['Person', 'Organization'],
        },
        creator: {
          type: 'Person',
          id: 'user1',
          name: 'user1',
        },
      });
    });

    it('should create stub reference without targetDocumentId', async () => {
      const event: DocumentEvent = {
        id: 'evt-8',
        type: 'reference.created',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          referenceId: 'ref-456',
          exact: 'stub reference',
          position: { offset: 30, length: 14 },
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

      expect(mockGraphDB.createAnnotation).toHaveBeenCalledWith({
        id: 'ref-456',
        target: {
          source: 'doc-123',
          selector: {
            type: 'TextPositionSelector',
            exact: 'stub reference',
            offset: 30,
            length: 14,
          },
        },
        body: {
          type: 'SpecificResource',
          source: undefined,
          entityTypes: [],
        },
        creator: {
          type: 'Person',
          id: 'user1',
          name: 'user1',
        },
      });
    });
  });

  describe('reference.resolved event', () => {
    it('should resolve reference in GraphDB', async () => {
      const event: DocumentEvent = {
        id: 'evt-9',
        type: 'reference.resolved',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          referenceId: 'ref-456',
          targetDocumentId: 'doc-789',
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

      expect(mockGraphDB.updateAnnotation).toHaveBeenCalledWith('ref-456', {
        body: {
          type: 'SpecificResource',
          entityTypes: [],
          source: 'doc-789',
        },
      });
    });
  });

  describe('reference.deleted event', () => {
    it('should delete reference from GraphDB', async () => {
      const event: DocumentEvent = {
        id: 'evt-10',
        type: 'reference.deleted',
        documentId: 'doc-123',
        userId: 'user1',
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          referenceId: 'ref-123',
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

      expect(mockGraphDB.deleteAnnotation).toHaveBeenCalledWith('ref-123');
    });
  });

  describe('entitytag.added event', () => {
    it('should add entity tag to document', async () => {
      const event: DocumentEvent = {
        id: 'evt-11',
        type: 'entitytag.added',
        documentId: 'doc-123',
        userId: 'user1',
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

      expect(mockGraphDB.getDocument).toHaveBeenCalledWith('doc-123');
      expect(mockGraphDB.updateDocument).toHaveBeenCalledWith('doc-123', {
        entityTypes: ['entity1', 'NewEntity'],
      });
    });
  });

  describe('entitytag.removed event', () => {
    it('should remove entity tag from document', async () => {
      const event: DocumentEvent = {
        id: 'evt-12',
        type: 'entitytag.removed',
        documentId: 'doc-123',
        userId: 'user1',
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

      expect(mockGraphDB.getDocument).toHaveBeenCalledWith('doc-123');
      expect(mockGraphDB.updateDocument).toHaveBeenCalledWith('doc-123', {
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