/**
 * Gatherer Actor Tests
 *
 * Tests the Gatherer's RxJS pipeline:
 * - Annotation-level gather (gather:requested → gather:complete/gather:failed)
 * - Resource-level gather (gather:resource-requested → gather:resource-complete/gather:resource-failed)
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, annotationId, resourceId, type Logger } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';
import { Gatherer } from '../gatherer';

// Mock AnnotationContext and LLMContext
vi.mock('../annotation-context', () => ({
  AnnotationContext: {
    buildLLMContext: vi.fn(),
  },
}));

vi.mock('../llm-context', () => ({
  LLMContext: {
    getResourceContext: vi.fn(),
  },
}));

import { AnnotationContext } from '../annotation-context';
import { LLMContext } from '../llm-context';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const mockInferenceClient = {
  generateText: vi.fn(),
  generateTextWithMetadata: vi.fn(),
};

function createMockKb(): KnowledgeBase {
  return {
    eventStore: {} as any,
    views: {} as any,
    content: {} as any,
    graph: {} as any,
    projectionsDir: '',
      graphConsumer: {} as any,
  };
}

describe('Gatherer', () => {
  let eventBus: EventBus;
  let gatherer: Gatherer;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    kb = createMockKb();
    gatherer = new Gatherer(kb, eventBus, mockInferenceClient as any, mockLogger);
    await gatherer.initialize();
  });

  afterEach(async () => {
    await gatherer.stop();
    eventBus.destroy();
  });

  describe('annotation-level gather', () => {
    it('should emit gather:complete on success', async () => {
      const mockContext = {
        annotation: {
          id: 'ann-1',
          '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
          type: 'Annotation' as const,
          motivation: 'linking' as const,
          target: { source: 'res-1' },
          body: { type: 'SpecificResource' as const, source: '' },
        },
        sourceResource: {
          '@context': 'https://schema.org',
          '@id': 'res-1',
          name: 'Test Resource',
          format: 'text/plain',
          representations: [] as [],
        },
        sourceContext: { before: 'before', selected: 'selected', after: 'after' },
        metadata: { resourceType: 'document' as const },
      };

      vi.mocked(AnnotationContext.buildLLMContext).mockResolvedValue({
        annotation: {} as any,
        sourceResource: {} as any,
        targetResource: null,
        context: mockContext,
      });

      const resultPromise = eventBus.scope('res-1').get('gather:complete').pipe(take(1)).toPromise();

      eventBus.get('gather:requested').next({
        correlationId: 'test-corr-id',
        annotationId: annotationId('ann-1'),
        resourceId: resourceId('res-1'),
      });

      const result = await resultPromise;
      expect(result!.annotationId).toBe('ann-1');
      expect(result!.response.context).toEqual(mockContext);

      expect(AnnotationContext.buildLLMContext).toHaveBeenCalledWith(
        'ann-1',
        'res-1',
        kb,
        {},
        mockInferenceClient,
        mockLogger,
        undefined,
      );
    });

    it('should emit gather:failed on error', async () => {
      vi.mocked(AnnotationContext.buildLLMContext).mockRejectedValue(new Error('Annotation not found'));

      const resultPromise = eventBus.scope('res-1').get('gather:failed').pipe(take(1)).toPromise();

      eventBus.get('gather:requested').next({
        correlationId: 'test-corr-id',
        annotationId: annotationId('ann-2'),
        resourceId: resourceId('res-1'),
      });

      const result = await resultPromise;
      expect(result!.annotationId).toBe('ann-2');
      expect(result!.message).toBe('Annotation not found');
    });
  });

  describe('resource-level gather', () => {
    it('should emit gather:resource-complete on success', async () => {
      const mockResponse = {
        mainResource: { name: 'Test Resource' } as any,
        relatedResources: [],
        annotations: [],
        graph: { nodes: [], edges: [] },
      };

      vi.mocked(LLMContext.getResourceContext).mockResolvedValue(mockResponse as any);

      const resultPromise = eventBus.scope('res-1').get('gather:resource-complete').pipe(take(1)).toPromise();

      eventBus.get('gather:resource-requested').next({
        correlationId: 'test-corr-id',
        resourceId: resourceId('res-1'),
        options: { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
      });

      const result = await resultPromise;
      expect(result!.resourceId).toBe('res-1');
      expect(result!.response).toEqual(mockResponse);

      expect(LLMContext.getResourceContext).toHaveBeenCalledWith(
        'res-1',
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        kb,
        mockInferenceClient,
      );
    });

    it('should emit gather:resource-failed on error', async () => {
      vi.mocked(LLMContext.getResourceContext).mockRejectedValue(new Error('Resource not found'));

      const resultPromise = eventBus.scope('res-2').get('gather:resource-failed').pipe(take(1)).toPromise();

      eventBus.get('gather:resource-requested').next({
        correlationId: 'test-corr-id',
        resourceId: resourceId('res-2'),
        options: { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
      });

      const result = await resultPromise;
      expect(result!.resourceId).toBe('res-2');
      expect(result!.message).toBe('Resource not found');
    });
  });

  describe('lifecycle', () => {
    it('should stop cleanly', async () => {
      await gatherer.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Gatherer actor stopped');
    });

    it('should not process events after stop', async () => {
      await gatherer.stop();

      vi.mocked(AnnotationContext.buildLLMContext).mockResolvedValue({} as any);

      eventBus.get('gather:requested').next({
        correlationId: 'test-corr-id',
        annotationId: annotationId('ann-3'),
        resourceId: resourceId('res-1'),
      });

      // Give time for any processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(AnnotationContext.buildLLMContext).not.toHaveBeenCalled();
    });
  });
});
