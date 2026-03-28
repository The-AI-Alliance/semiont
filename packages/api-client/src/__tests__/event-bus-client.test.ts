/**
 * EventBusClient tests
 *
 * Tests the EventBus-only client by simulating actor responses.
 * Each test subscribes to the request event, then defers the response
 * to the next microtask (queueMicrotask) so that firstValueFrom has
 * time to subscribe before the response is emitted.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { EventBus, resourceId, annotationId, jobId, userId } from '@semiont/core';
import type { components } from '@semiont/core';
import { EventBusClient } from '../event-bus-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

/**
 * Helper: respond to an event on the next microtask.
 * This is necessary because eventBusRequest() calls next() synchronously
 * then subscribes via firstValueFrom() — the response must be deferred.
 */
function respondAsync(fn: () => void): void {
  queueMicrotask(fn);
}

/** Minimal ResourceDescriptor satisfying required fields */
function mockResource(overrides: Partial<ResourceDescriptor> & { name: string }): ResourceDescriptor {
  return {
    '@context': 'http://schema.org',
    '@id': `http://example.com/resources/${overrides.name}`,
    representations: [],
    ...overrides,
  };
}

/** Minimal Annotation satisfying required fields */
function mockAnnotation(overrides?: Partial<Annotation>): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: 'http://example.com/annotations/1',
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: 'http://example.com/resources/1' },
    body: [],
    ...overrides,
  };
}

describe('EventBusClient', () => {
  let eventBus: EventBus;
  let client: EventBusClient;

  beforeEach(() => {
    eventBus = new EventBus();
    client = new EventBusClient(eventBus, 5_000);
  });

  afterEach(() => {
    eventBus.destroy();
  });

  // ========================================================================
  // Browse Flow — Resources
  // ========================================================================

  describe('browseResource', () => {
    test('should return resource on success', async () => {
      const rId = resourceId('test-123');
      const mockResponse: components['schemas']['GetResourceResponse'] = {
        resource: mockResource({ name: 'Test' }),
        annotations: [],
        entityReferences: [],
      };

      eventBus.get('browse:resource-requested').subscribe((e) => {
        respondAsync(() => {
          eventBus.get('browse:resource-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.browseResource(rId);
      expect(result).toEqual(mockResponse);
    });

    test('should throw on failure', async () => {
      const rId = resourceId('bad-id');

      eventBus.get('browse:resource-requested').subscribe((e) => {
        respondAsync(() => {
          eventBus.get('browse:resource-failed').next({
            correlationId: e.correlationId,
            error: new Error('Resource not found'),
          });
        });
      });

      await expect(client.browseResource(rId)).rejects.toThrow('Resource not found');
    });
  });

  describe('browseResources', () => {
    test('should return resources list with options', async () => {
      const mockResponse: components['schemas']['ListResourcesResponse'] = {
        resources: [],
        total: 0,
        offset: 0,
        limit: 10,
      };

      eventBus.get('browse:resources-requested').subscribe((e) => {
        expect(e.limit).toBe(10);
        expect(e.archived).toBe(false);
        respondAsync(() => {
          eventBus.get('browse:resources-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.browseResources({ limit: 10, archived: false });
      expect(result).toEqual(mockResponse);
    });

    test('should work with no options', async () => {
      const mockResponse: components['schemas']['ListResourcesResponse'] = {
        resources: [],
        total: 0,
        offset: 0,
        limit: 20,
      };

      eventBus.get('browse:resources-requested').subscribe((e) => {
        respondAsync(() => {
          eventBus.get('browse:resources-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.browseResources();
      expect(result).toEqual(mockResponse);
    });
  });

  // ========================================================================
  // Browse Flow — Annotations
  // ========================================================================

  describe('getAnnotations', () => {
    test('should return annotations', async () => {
      const rId = resourceId('doc-1');
      const mockResponse: components['schemas']['GetAnnotationsResponse'] = {
        annotations: [],
        total: 0,
      };

      eventBus.get('browse:annotations-requested').subscribe((e) => {
        expect(e.resourceId).toBe(rId);
        respondAsync(() => {
          eventBus.get('browse:annotations-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.getAnnotations(rId);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getAnnotation', () => {
    test('should return single annotation', async () => {
      const rId = resourceId('doc-1');
      const aId = annotationId('ann-1');
      const mockResponse: components['schemas']['GetAnnotationResponse'] = {
        annotation: mockAnnotation({ id: 'ann-1' }),
        resource: null,
        resolvedResource: null,
      };

      eventBus.get('browse:annotation-requested').subscribe((e) => {
        expect(e.resourceId).toBe(rId);
        expect(e.annotationId).toBe(aId);
        respondAsync(() => {
          eventBus.get('browse:annotation-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.getAnnotation(rId, aId);
      expect(result).toEqual(mockResponse);
    });
  });

  // ========================================================================
  // Browse Flow — Events
  // ========================================================================

  describe('getEvents', () => {
    test('should return events with options', async () => {
      const rId = resourceId('doc-1');
      const mockResponse: components['schemas']['GetEventsResponse'] = {
        events: [],
        total: 0,
        resourceId: 'doc-1',
      };

      eventBus.get('browse:events-requested').subscribe((e) => {
        expect(e.resourceId).toBe(rId);
        expect(e.limit).toBe(5);
        respondAsync(() => {
          eventBus.get('browse:events-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.getEvents(rId, { limit: 5 });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getAnnotationHistory', () => {
    test('should return annotation history', async () => {
      const rId = resourceId('doc-1');
      const aId = annotationId('ann-1');
      const mockResponse: components['schemas']['GetAnnotationHistoryResponse'] = {
        events: [],
        total: 0,
        annotationId: 'ann-1',
        resourceId: 'doc-1',
      };

      eventBus.get('browse:annotation-history-requested').subscribe((e) => {
        expect(e.resourceId).toBe(rId);
        expect(e.annotationId).toBe(aId);
        respondAsync(() => {
          eventBus.get('browse:annotation-history-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.getAnnotationHistory(rId, aId);
      expect(result).toEqual(mockResponse);
    });
  });

  // ========================================================================
  // Bind Flow
  // ========================================================================

  describe('getReferencedBy', () => {
    test('should return referenced-by results', async () => {
      const rId = resourceId('doc-1');
      const mockResponse: components['schemas']['GetReferencedByResponse'] = {
        referencedBy: [],
      };

      eventBus.get('browse:referenced-by-requested').subscribe((e) => {
        expect(e.resourceId).toBe(rId);
        respondAsync(() => {
          eventBus.get('browse:referenced-by-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.getReferencedBy(rId);
      expect(result).toEqual(mockResponse);
    });

    test('should pass motivation filter', async () => {
      const rId = resourceId('doc-1');

      eventBus.get('browse:referenced-by-requested').subscribe((e) => {
        expect(e.motivation).toBe('linking');
        respondAsync(() => {
          eventBus.get('browse:referenced-by-result').next({
            correlationId: e.correlationId,
            response: { referencedBy: [] },
          });
        });
      });

      await client.getReferencedBy(rId, 'linking');
    });
  });

  describe('searchResources', () => {
    test('should return search results', async () => {
      const mockResults: ResourceDescriptor[] = [
        mockResource({ name: 'Doc 1' }),
        mockResource({ name: 'Doc 2' }),
      ];

      eventBus.get('match:search-requested').subscribe((e) => {
        expect(e.context.sourceContext?.selected).toBe('quantum');
        respondAsync(() => {
          eventBus.get('match:search-results').next({
            correlationId: e.correlationId,
            referenceId: e.referenceId,
            results: mockResults,
          });
        });
      });

      const result = await client.searchResources('quantum');
      expect(result).toEqual(mockResults);
    });

    test('should throw on search failure', async () => {
      eventBus.get('match:search-requested').subscribe((e) => {
        respondAsync(() => {
          eventBus.get('match:search-failed').next({
            referenceId: e.referenceId,
            correlationId: e.correlationId,
            error: new Error('Search unavailable'),
          });
        });
      });

      await expect(client.searchResources('test')).rejects.toThrow('Search unavailable');
    });
  });

  // ========================================================================
  // Mark Flow
  // ========================================================================

  describe('listEntityTypes', () => {
    test('should return entity types', async () => {
      const mockResponse: components['schemas']['GetEntityTypesResponse'] = {
        entityTypes: ['Person', 'Organization'],
      };

      eventBus.get('browse:entity-types-requested').subscribe((e) => {
        respondAsync(() => {
          eventBus.get('browse:entity-types-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.listEntityTypes();
      expect(result).toEqual(mockResponse);
    });
  });

  describe('addEntityType', () => {
    test('should emit add-entity-type event', () => {
      let received = false;
      const uid = userId('user-1');

      eventBus.get('mark:add-entity-type').subscribe((e) => {
        expect(e.tag).toBe('Location');
        expect(e.userId).toBe(uid);
        received = true;
      });

      client.addEntityType('Location', uid);
      expect(received).toBe(true);
    });
  });

  // ========================================================================
  // Yield Flow — Clone tokens
  // ========================================================================

  describe('generateCloneToken', () => {
    test('should return clone token', async () => {
      const rId = resourceId('doc-1');
      const mockResponse: components['schemas']['CloneResourceWithTokenResponse'] = {
        token: 'abc123',
        expiresAt: '2026-04-01',
        resource: mockResource({ name: 'Test' }),
      };

      eventBus.get('yield:clone-token-requested').subscribe((e) => {
        expect(e.resourceId).toBe(rId);
        respondAsync(() => {
          eventBus.get('yield:clone-token-generated').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.generateCloneToken(rId);
      expect(result.token).toBe('abc123');
    });
  });

  describe('getResourceByToken', () => {
    test('should return resource for token', async () => {
      const mockResponse: components['schemas']['GetResourceByTokenResponse'] = {
        sourceResource: mockResource({ name: 'Cloned Doc' }),
        expiresAt: '2026-04-01',
      };

      eventBus.get('yield:clone-resource-requested').subscribe((e) => {
        expect(e.token).toBe('token-xyz');
        respondAsync(() => {
          eventBus.get('yield:clone-resource-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.getResourceByToken('token-xyz');
      expect(result.sourceResource.name).toBe('Cloned Doc');
    });
  });

  describe('createResourceFromToken', () => {
    test('should create resource and return id', async () => {
      const rId = resourceId('new-123');
      const uid = userId('user-1');

      eventBus.get('yield:clone-create').subscribe((e) => {
        expect(e.token).toBe('token-abc');
        expect(e.name).toBe('New Doc');
        respondAsync(() => {
          eventBus.get('yield:clone-created').next({
            correlationId: e.correlationId,
            response: { resourceId: rId },
          });
        });
      });

      const result = await client.createResourceFromToken({
        token: 'token-abc',
        name: 'New Doc',
        content: 'Hello',
        userId: uid,
      });
      expect(result.resourceId).toBe(rId);
    });
  });

  // ========================================================================
  // Job Control
  // ========================================================================

  describe('getJobStatus', () => {
    test('should return job status', async () => {
      const jId = jobId('job-1');
      const mockResponse: components['schemas']['JobStatusResponse'] = {
        jobId: 'job-1',
        type: 'reference-annotation',
        status: 'complete',
        userId: 'user-1',
        created: '2026-01-01T00:00:00Z',
      };

      eventBus.get('job:status-requested').subscribe((e) => {
        expect(e.jobId).toBe(jId);
        respondAsync(() => {
          eventBus.get('job:status-result').next({
            correlationId: e.correlationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.getJobStatus(jId);
      expect(result).toEqual(mockResponse);
    });
  });

  // ========================================================================
  // Gather Flow — LLM context
  // ========================================================================

  describe('gatherAnnotation', () => {
    test('should return annotation LLM context', async () => {
      const mockResponse: components['schemas']['AnnotationLLMContextResponse'] = {
        annotation: mockAnnotation(),
        sourceResource: mockResource({ name: 'Source' }),
        sourceContext: { before: 'a', selected: 'b', after: 'c' },
      };

      eventBus.get('gather:requested').subscribe((e) => {
        expect(e.annotationId).toBe('ann-1');
        expect(e.resourceId).toBe('res-1');
        respondAsync(() => {
          eventBus.get('gather:complete').next({
            correlationId: e.correlationId,
            annotationId: e.annotationId,
            response: mockResponse,
          });
        });
      });

      const result = await client.gatherAnnotation(
        annotationId('ann-1'),
        resourceId('res-1'),
        { contextWindow: 500 },
      );
      expect(result).toEqual(mockResponse);
    });

    test('should throw on gather failure', async () => {
      eventBus.get('gather:requested').subscribe((e) => {
        respondAsync(() => {
          eventBus.get('gather:failed').next({
            correlationId: e.correlationId,
            annotationId: e.annotationId,
            error: new Error('Context assembly failed'),
          });
        });
      });

      await expect(
        client.gatherAnnotation(annotationId('ann-1'), resourceId('res-1')),
      ).rejects.toThrow('Context assembly failed');
    });
  });

  describe('gatherResource', () => {
    test('should return resource LLM context', async () => {
      const mockContext: components['schemas']['ResourceLLMContextResponse'] = {
        mainResource: mockResource({ name: 'Main' }),
        relatedResources: [],
        annotations: [],
        graph: { nodes: [], edges: [] },
      };

      eventBus.get('gather:resource-requested').subscribe((e) => {
        expect(e.resourceId).toBe('res-1');
        expect(e.options.depth).toBe(2);
        respondAsync(() => {
          eventBus.get('gather:resource-complete').next({
            correlationId: e.correlationId,
            resourceId: e.resourceId,
            context: mockContext,
          });
        });
      });

      const result = await client.gatherResource(
        resourceId('res-1'),
        { depth: 2, maxResources: 10, includeContent: true, includeSummary: false },
      );
      expect(result).toEqual(mockContext);
    });

    test('should throw on resource gather failure', async () => {
      eventBus.get('gather:resource-requested').subscribe((e) => {
        respondAsync(() => {
          eventBus.get('gather:resource-failed').next({
            correlationId: e.correlationId,
            resourceId: e.resourceId,
            error: new Error('Graph traversal failed'),
          });
        });
      });

      await expect(
        client.gatherResource(resourceId('res-1'), { depth: 1, maxResources: 5, includeContent: true, includeSummary: false }),
      ).rejects.toThrow('Graph traversal failed');
    });
  });

  // ========================================================================
  // Timeout
  // ========================================================================

  describe('timeout', () => {
    test('should timeout if no response', async () => {
      const fastClient = new EventBusClient(eventBus, 50);
      await expect(fastClient.browseResource(resourceId('timeout-test'))).rejects.toThrow();
    });
  });
});
