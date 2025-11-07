/**
 * Unit tests for SemiontApiClient with mocked HTTP
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { KyInstance } from 'ky';

// Mock ky module
vi.mock('ky', () => ({
  default: {
    create: vi.fn(),
  },
}));

import ky from 'ky';
import { SemiontApiClient } from '../client';
import type { ResourceUri, ResourceAnnotationUri } from '../uri-types';
import { baseUrl, entityType, jobId } from '../branded-types';

describe('SemiontApiClient - Archive Operations', () => {
  let client: SemiontApiClient;
  let mockKy: KyInstance;
  const testBaseUrl = baseUrl('http://localhost:4000');
  const testResourceUri: ResourceUri = `${testBaseUrl}/resources/test-resource-id` as ResourceUri;

  beforeEach(() => {
    // Create mock ky instance with chainable methods
    mockKy = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as any;

    // Mock ky.create to return our mock instance
    vi.mocked(ky.create).mockReturnValue(mockKy);

    client = new SemiontApiClient({
      baseUrl: testBaseUrl,
      timeout: 10000,
    });
  });

  describe('updateResource - archive operations', () => {
    test('should archive a resource', async () => {
      const mockResponse = {
        resource: {
          id: 'test-resource-id',
          name: 'Test Resource',
          archived: true,
          entityTypes: [],
        },
        annotations: [],
        entityReferences: [],
      };

      vi.mocked(mockKy.patch).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.updateResource(testResourceUri, {
        archived: true,
      });

      expect(result.resource.archived).toBe(true);
      expect(mockKy.patch).toHaveBeenCalledWith(
        testResourceUri,
        expect.objectContaining({
          json: { archived: true },
        })
      );
    });

    test('should unarchive a resource', async () => {
      const mockResponse = {
        resource: {
          id: 'test-resource-id',
          name: 'Test Resource',
          archived: false,
          entityTypes: [],
        },
        annotations: [],
        entityReferences: [],
      };

      vi.mocked(mockKy.patch).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.updateResource(testResourceUri, {
        archived: false,
      });

      expect(result.resource.archived).toBe(false);
      expect(mockKy.patch).toHaveBeenCalledWith(
        testResourceUri,
        expect.objectContaining({
          json: { archived: false },
        })
      );
    });

    test('should update entity types and archive in single operation', async () => {
      const mockResponse = {
        resource: {
          id: 'test-resource-id',
          name: 'Test Resource',
          archived: true,
          entityTypes: ['article', 'draft'],
        },
        annotations: [],
        entityReferences: [],
      };

      vi.mocked(mockKy.patch).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.updateResource(testResourceUri, {
        archived: true,
        entityTypes: ['article', 'draft'],
      });

      expect(result.resource.archived).toBe(true);
      expect(result.resource.entityTypes).toEqual(['article', 'draft']);
      expect(mockKy.patch).toHaveBeenCalledWith(
        testResourceUri,
        expect.objectContaining({
          json: {
            archived: true,
            entityTypes: ['article', 'draft'],
          },
        })
      );
    });
  });

  describe('listResources - filter by archived', () => {
    test('should list only active resources', async () => {
      const mockResponse = {
        resources: [
          { id: 'res1', name: 'Active 1', archived: false },
          { id: 'res2', name: 'Active 2', archived: false },
        ],
        total: 2,
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.listResources(10, false);

      expect(result.resources).toHaveLength(2);
      expect(result.resources.every(r => !r.archived)).toBe(true);
      expect(mockKy.get).toHaveBeenCalledWith(
        `${testBaseUrl}/resources`,
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );
    });

    test('should list only archived resources', async () => {
      const mockResponse = {
        resources: [
          { id: 'res3', name: 'Archived 1', archived: true },
        ],
        total: 1,
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.listResources(10, true);

      expect(result.resources).toHaveLength(1);
      expect(result.resources.every(r => r.archived)).toBe(true);
      expect(mockKy.get).toHaveBeenCalledWith(
        `${testBaseUrl}/resources`,
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );
    });
  });

  describe('Entity Detection and Jobs', () => {
    test('should start entity detection job', async () => {
      const mockResponse = {
        jobId: 'job-123',
        status: 'pending',
        type: 'detection',
        message: 'Entity detection job created',
      };

      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.detectEntities(testResourceUri, [entityType('person'), entityType('organization')]);

      expect(result.jobId).toBe('job-123');
      expect(result.status).toBe('pending');
      expect(mockKy.post).toHaveBeenCalledWith(
        `${testResourceUri}/detect-entities`,
        expect.objectContaining({
          json: { entityTypes: ['person', 'organization'] },
        })
      );
    });

    test('should start entity detection job without entity types', async () => {
      const mockResponse = {
        jobId: 'job-456',
        status: 'pending',
        type: 'detection',
      };

      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.detectEntities(testResourceUri);

      expect(result.jobId).toBe('job-456');
      expect(mockKy.post).toHaveBeenCalledWith(
        `${testResourceUri}/detect-entities`,
        expect.objectContaining({
          json: {},
        })
      );
    });

    test('should get job status', async () => {
      const mockResponse = {
        jobId: 'job-123',
        type: 'detection',
        status: 'running',
        userId: 'user-1',
        created: '2024-01-01T00:00:00Z',
        progress: {
          current: 50,
          total: 100,
          message: 'Processing entities...',
        },
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getJobStatus(jobId('job-123'));

      expect(result.status).toBe('running');
      expect(result.jobId).toBe('job-123');
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/jobs/job-123`);
    });

    test('should poll job until complete', async () => {
      const responses = [
        { jobId: 'job-123', status: 'pending', type: 'detection', created: '2024-01-01T00:00:00Z', userId: 'user-1' },
        { jobId: 'job-123', status: 'running', type: 'detection', created: '2024-01-01T00:00:00Z', userId: 'user-1' },
        { jobId: 'job-123', status: 'complete', type: 'detection', created: '2024-01-01T00:00:00Z', userId: 'user-1', result: { detected: 5 } },
      ];

      let callCount = 0;
      vi.mocked(mockKy.get).mockImplementation(() => ({
        json: vi.fn().mockResolvedValue(responses[callCount++]),
      } as any));

      const progressCalls: any[] = [];
      const result = await client.pollJobUntilComplete(jobId('job-123'), {
        interval: 10, // Fast polling for tests
        onProgress: (status) => progressCalls.push(status),
      });

      expect(result.status).toBe('complete');
      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[0].status).toBe('pending');
      expect(progressCalls[1].status).toBe('running');
      expect(progressCalls[2].status).toBe('complete');
    });

    test('should timeout when polling takes too long', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue({
          jobId: 'job-123',
          status: 'running',
          type: 'detection',
          created: '2024-01-01T00:00:00Z',
          userId: 'user-1',
        }),
      } as any);

      await expect(
        client.pollJobUntilComplete(jobId('job-123'), {
          interval: 10,
          timeout: 50, // Very short timeout for testing
        })
      ).rejects.toThrow('Job polling timeout after 50ms');
    });
  });

  describe('LLM Context Operations', () => {
    test('should get resource LLM context with default options', async () => {
      const mockResponse = {
        mainResource: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          '@id': 'test-resource-id',
          name: 'Test Resource',
          content: 'Full content here',
        },
        relatedResources: [],
        annotations: [],
        graph: { nodes: [], edges: [] },
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getResourceLLMContext(testResourceUri);

      expect(result.mainResource.name).toBe('Test Resource');
      expect(mockKy.get).toHaveBeenCalledWith(
        `${testResourceUri}/llm-context`,
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );
    });

    test('should get resource LLM context with custom options', async () => {
      const mockResponse = {
        mainResource: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          '@id': 'test-resource-id',
          name: 'Test Resource',
        },
        relatedResources: [],
        annotations: [],
        graph: { nodes: [], edges: [] },
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getResourceLLMContext(testResourceUri, {
        depth: 3,
        maxResources: 15,
        includeContent: true,
        includeSummary: true,
      });

      expect(result.mainResource).toBeDefined();
      const call = vi.mocked(mockKy.get).mock.calls[0];
      const searchParams = call[1]?.searchParams as URLSearchParams;
      expect(searchParams.get('depth')).toBe('3');
      expect(searchParams.get('maxResources')).toBe('15');
      expect(searchParams.get('includeContent')).toBe('true');
      expect(searchParams.get('includeSummary')).toBe('true');
    });

    test('should get annotation LLM context with default options', async () => {
      const annotationUri = `${testResourceUri}/annotations/ann-123` as ResourceAnnotationUri;
      const mockResponse = {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: 'ann-123',
          motivation: 'highlighting',
          target: { source: testResourceUri },
          body: [],
        },
        sourceResource: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          '@id': 'source-id',
          name: 'Source Resource',
        },
        targetResource: null,
        sourceContext: {
          before: 'Text before',
          selected: 'Selected text',
          after: 'Text after',
        },
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getAnnotationLLMContext(annotationUri);

      expect(result.annotation.id).toBe('ann-123');
      expect(mockKy.get).toHaveBeenCalledWith(
        `${annotationUri}/llm-context`,
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );
    });

    test('should get annotation LLM context with custom options', async () => {
      const annotationUri = `${testResourceUri}/annotations/ann-123` as ResourceAnnotationUri;
      const mockResponse = {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: 'ann-123',
          motivation: 'linking',
          target: { source: testResourceUri },
          body: [],
        },
        sourceResource: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          '@id': 'source-id',
          name: 'Source',
        },
        targetResource: null,
        sourceContext: {
          before: 'Limited',
          selected: 'text',
          after: 'here',
        },
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getAnnotationLLMContext(annotationUri, {
        includeSourceContext: true,
        includeTargetContext: false,
        contextWindow: 500,
      });

      expect(result.sourceContext).toBeDefined();
      const call = vi.mocked(mockKy.get).mock.calls[0];
      const searchParams = call[1]?.searchParams as URLSearchParams;
      expect(searchParams.get('includeSourceContext')).toBe('true');
      expect(searchParams.get('includeTargetContext')).toBe('false');
      expect(searchParams.get('contextWindow')).toBe('500');
    });
  });

  describe('User Operations', () => {
    test('should logout user', async () => {
      const mockResponse = {
        message: 'Logged out successfully',
      };

      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.logout();

      expect(result.message).toBe('Logged out successfully');
      expect(mockKy.post).toHaveBeenCalledWith(`${testBaseUrl}/api/users/logout`);
    });
  });

  describe('System Status', () => {
    test('should get system status', async () => {
      const mockResponse = {
        status: 'healthy',
        version: '1.0.0',
        features: {
          semanticContent: 'enabled',
          collaboration: 'enabled',
          rbac: 'disabled',
        },
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getStatus();

      expect(result.version).toBe('1.0.0');
      expect(result.features.semanticContent).toBe('enabled');
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/status`);
    });
  });

  describe('Entity Types Bulk Operations', () => {
    test('should add multiple entity types at once', async () => {
      const mockResponse = {
        success: true,
        entityTypes: ['concept', 'person', 'organization'],
      };

      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.addEntityTypesBulk([entityType('concept'), entityType('person'), entityType('organization')]);

      expect(result.success).toBe(true);
      expect(result.entityTypes).toHaveLength(3);
      expect(mockKy.post).toHaveBeenCalledWith(
        `${testBaseUrl}/api/entity-types/bulk`,
        expect.objectContaining({
          json: { tags: [entityType('concept'), entityType('person'), entityType('organization')] },
        })
      );
    });
  });

  describe('Annotation History', () => {
    test('should get annotation event history', async () => {
      const annotationUri = `${testResourceUri}/annotations/ann-123` as ResourceAnnotationUri;
      const mockResponse = {
        events: [
          {
            id: 'evt-1',
            type: 'highlight.created',
            timestamp: '2024-01-01T00:00:00Z',
            userId: 'user-1',
            resourceId: 'test-resource-id',
            payload: { highlightId: 'ann-123' },
            metadata: {
              sequenceNumber: 1,
              prevEventHash: 'hash-0',
              checksum: 'checksum-1',
            },
          },
          {
            id: 'evt-2',
            type: 'highlight.updated',
            timestamp: '2024-01-01T00:01:00Z',
            userId: 'user-1',
            resourceId: 'test-resource-id',
            payload: { highlightId: 'ann-123' },
            metadata: {
              sequenceNumber: 2,
              prevEventHash: 'hash-1',
              checksum: 'checksum-2',
            },
          },
        ],
        total: 2,
        annotationId: 'ann-123',
        resourceId: 'test-resource-id',
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getAnnotationHistory(annotationUri);

      expect(result.total).toBe(2);
      expect(result.events).toHaveLength(2);
      expect(result.annotationId).toBe('ann-123');
      expect(result.events[0].metadata.sequenceNumber).toBe(1);
      expect(mockKy.get).toHaveBeenCalledWith(`${annotationUri}/history`);
    });
  });

  describe('W3C Content Negotiation', () => {
    test('should get resource representation with default accept header', async () => {
      const mockText = '# Hello World\n\nThis is markdown content.';

      vi.mocked(mockKy.get).mockReturnValue({
        text: vi.fn().mockResolvedValue(mockText),
      } as any);

      const result = await client.getResourceRepresentation(testResourceUri);

      expect(result).toBe(mockText);
      expect(mockKy.get).toHaveBeenCalledWith(
        testResourceUri,
        expect.objectContaining({
          headers: {
            Accept: 'text/plain',
          },
        })
      );
    });

    test('should get resource representation with custom accept header', async () => {
      const mockMarkdown = '# Title\n\n## Section\n\nContent here.';

      vi.mocked(mockKy.get).mockReturnValue({
        text: vi.fn().mockResolvedValue(mockMarkdown),
      } as any);

      const result = await client.getResourceRepresentation(testResourceUri, {
        accept: 'text/markdown',
      });

      expect(result).toBe(mockMarkdown);
      expect(mockKy.get).toHaveBeenCalledWith(
        testResourceUri,
        expect.objectContaining({
          headers: {
            Accept: 'text/markdown',
          },
        })
      );
    });

    test('should get resource representation with text/plain', async () => {
      const mockText = 'Hello World';

      vi.mocked(mockKy.get).mockReturnValue({
        text: vi.fn().mockResolvedValue(mockText),
      } as any);

      const result = await client.getResourceRepresentation(testResourceUri, {
        accept: 'text/plain',
      });

      expect(result).toBe(mockText);
      expect(mockKy.get).toHaveBeenCalledWith(
        testResourceUri,
        expect.objectContaining({
          headers: {
            Accept: 'text/plain',
          },
        })
      );
    });
  });
});

/**
 * Example usage documentation
 *
 * Archive a resource:
 * ```typescript
 * await client.updateResource(resourceUri, { archived: true });
 * ```
 *
 * Unarchive a resource:
 * ```typescript
 * await client.updateResource(resourceUri, { archived: false });
 * ```
 *
 * List active resources only:
 * ```typescript
 * const active = await client.listResources(20, false);
 * ```
 *
 * List archived resources only:
 * ```typescript
 * const archived = await client.listResources(20, true);
 * ```
 */
