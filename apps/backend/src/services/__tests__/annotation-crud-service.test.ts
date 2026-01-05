import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnotationCrudService } from '../annotation-crud-service';
import type { EnvironmentConfig } from '@semiont/core';
import type { User } from '@prisma/client';
import type { components } from '@semiont/api-client';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];
type Annotation = components['schemas']['Annotation'];

// Mock dependencies
vi.mock('../event-store-service', () => ({
  createEventStore: vi.fn(),
}));

vi.mock('@semiont/make-meaning', () => ({
  AnnotationContext: {
    getAnnotation: vi.fn(),
    getResourceAnnotations: vi.fn(),
  },
}));

vi.mock('../../utils/id-generator', () => ({
  generateAnnotationId: vi.fn(),
  userToAgent: vi.fn(),
}));

import { createEventStore } from '../event-store-service';
import { AnnotationContext } from '@semiont/make-meaning';
import { generateAnnotationId, userToAgent } from '../../utils/id-generator';

describe('AnnotationCrudService', () => {
  let mockConfig: EnvironmentConfig;
  let mockUser: User;
  let mockEventStore: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        backend: { publicURL: 'http://localhost:4000' },
        filesystem: { path: '/test/data' },
      },
    } as EnvironmentConfig;

    mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
    } as User;

    mockEventStore = {
      appendEvent: vi.fn().mockResolvedValue({ metadata: { sequenceNumber: 1 } }),
    };

    vi.mocked(createEventStore).mockResolvedValue(mockEventStore);
    vi.mocked(generateAnnotationId).mockReturnValue('http://localhost:4000/annotations/anno-123');
    vi.mocked(userToAgent).mockReturnValue({
      type: 'Person',
      id: 'http://localhost:4000/users/user-123',
      name: 'Test User',
    });
  });

  describe('createAnnotation', () => {
    const validRequest: CreateAnnotationRequest = {
      motivation: 'commenting',
      target: {
        source: 'http://localhost:4000/resources/res-123',
        selector: {
          type: 'TextPositionSelector',
          start: 0,
          end: 10,
        },
      },
      body: {
        type: 'TextualBody',
        value: 'This is a comment',
        format: 'text/plain',
      },
    };

    it('should create annotation successfully', async () => {
      const result = await AnnotationCrudService.createAnnotation(
        validRequest,
        mockUser,
        mockConfig
      );

      expect(result.annotation.id).toBe('http://localhost:4000/annotations/anno-123');
      expect(result.annotation.motivation).toBe('commenting');
      expect(result.annotation.target).toEqual(validRequest.target);
      expect(result.annotation.body).toEqual(validRequest.body);
      expect(result.annotation.creator).toEqual({
        type: 'Person',
        id: 'http://localhost:4000/users/user-123',
        name: 'Test User',
      });
      expect(result.annotation.created).toBeDefined();
    });

    it('should emit annotation.added event', async () => {
      await AnnotationCrudService.createAnnotation(validRequest, mockUser, mockConfig);

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'annotation.added',
          resourceId: 'res-123',
          userId: 'user-123',
          payload: expect.objectContaining({
            annotation: expect.objectContaining({
              id: 'http://localhost:4000/annotations/anno-123',
              motivation: 'commenting',
            }),
          }),
        })
      );
    });

    it('should throw error when TextPositionSelector missing', async () => {
      const invalidRequest = {
        ...validRequest,
        target: {
          ...validRequest.target,
          selector: {
            type: 'FragmentSelector',
            value: '#section1',
          },
        },
      };

      await expect(
        AnnotationCrudService.createAnnotation(invalidRequest as any, mockUser, mockConfig)
      ).rejects.toThrow('TextPositionSelector required');
    });

    it('should throw error when motivation missing', async () => {
      const invalidRequest = {
        ...validRequest,
        motivation: undefined,
      };

      await expect(
        AnnotationCrudService.createAnnotation(invalidRequest as any, mockUser, mockConfig)
      ).rejects.toThrow('motivation is required');
    });

    it('should throw error when backend publicURL not configured', async () => {
      const invalidConfig = {
        services: {},
      } as EnvironmentConfig;

      await expect(
        AnnotationCrudService.createAnnotation(validRequest, mockUser, invalidConfig)
      ).rejects.toThrow('Backend publicURL not configured');
    });

    it('should generate unique annotation ID', async () => {
      await AnnotationCrudService.createAnnotation(validRequest, mockUser, mockConfig);

      expect(generateAnnotationId).toHaveBeenCalledWith('http://localhost:4000');
    });

    it('should set W3C annotation context', async () => {
      const result = await AnnotationCrudService.createAnnotation(
        validRequest,
        mockUser,
        mockConfig
      );

      expect(result.annotation['@context']).toBe('http://www.w3.org/ns/anno.jsonld');
      expect(result.annotation.type).toBe('Annotation');
    });

    it('should handle multiple body items', async () => {
      const requestWithMultipleBodies = {
        ...validRequest,
        body: [
          { type: 'TextualBody' as const, value: 'Comment 1', format: 'text/plain' as const },
          { type: 'TextualBody' as const, value: 'Comment 2', format: 'text/plain' as const },
        ],
      };

      const result = await AnnotationCrudService.createAnnotation(
        requestWithMultipleBodies,
        mockUser,
        mockConfig
      );

      expect(Array.isArray(result.annotation.body)).toBe(true);
      expect((result.annotation.body as any[]).length).toBe(2);
    });
  });

  describe('updateAnnotationBody', () => {
    const mockAnnotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: 'http://localhost:4000/annotations/anno-123',
      motivation: 'commenting',
      target: {
        source: 'http://localhost:4000/resources/res-123',
        selector: {
          type: 'TextPositionSelector',
          start: 0,
          end: 10,
        },
      },
      body: [
        { type: 'TextualBody' as const, value: 'Comment 1', format: 'text/plain' as const },
      ],
      creator: { type: 'Person' as const, id: 'http://localhost:4000/users/user-123', name: 'Test User' },
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
    };

    const updateRequest: UpdateAnnotationBodyRequest = {
      resourceId: 'http://localhost:4000/resources/res-123',
      operations: [
        {
          op: 'add',
          item: { type: 'TextualBody' as const, value: 'Comment 2', format: 'text/plain' as const },
        },
      ],
    };

    it('should update annotation body with add operation', async () => {
      vi.mocked(AnnotationContext.getAnnotation).mockResolvedValue(mockAnnotation);

      const result = await AnnotationCrudService.updateAnnotationBody(
        'anno-123',
        updateRequest,
        mockUser,
        mockConfig
      );

      expect(Array.isArray(result.annotation.body)).toBe(true);
      expect((result.annotation.body as any[]).length).toBe(2);
      expect((result.annotation.body as any[])[1]).toEqual({
        type: 'TextualBody',
        value: 'Comment 2',
        format: 'text/plain',
      });
    });

    it('should emit annotation.body.updated event', async () => {
      vi.mocked(AnnotationContext.getAnnotation).mockResolvedValue(mockAnnotation);

      await AnnotationCrudService.updateAnnotationBody(
        'anno-123',
        updateRequest,
        mockUser,
        mockConfig
      );

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'annotation.body.updated',
          resourceId: 'res-123',
          payload: expect.objectContaining({
            annotationId: 'anno-123',
            operations: updateRequest.operations,
          }),
        })
      );
    });

    it('should handle remove operation', async () => {
      vi.mocked(AnnotationContext.getAnnotation).mockResolvedValue(mockAnnotation);

      const removeRequest: UpdateAnnotationBodyRequest = {
        resourceId: 'http://localhost:4000/resources/res-123',
        operations: [
          {
            op: 'remove',
            item: { type: 'TextualBody' as const, value: 'Comment 1', format: 'text/plain' as const },
          },
        ],
      };

      const result = await AnnotationCrudService.updateAnnotationBody(
        'anno-123',
        removeRequest,
        mockUser,
        mockConfig
      );

      expect((result.annotation.body as any[]).length).toBe(0);
    });

    it('should handle replace operation', async () => {
      vi.mocked(AnnotationContext.getAnnotation).mockResolvedValue(mockAnnotation);

      const replaceRequest: UpdateAnnotationBodyRequest = {
        resourceId: 'http://localhost:4000/resources/res-123',
        operations: [
          {
            op: 'replace',
            oldItem: { type: 'TextualBody' as const, value: 'Comment 1', format: 'text/plain' as const },
            newItem: { type: 'TextualBody' as const, value: 'Updated Comment', format: 'text/plain' as const },
          },
        ],
      };

      const result = await AnnotationCrudService.updateAnnotationBody(
        'anno-123',
        replaceRequest,
        mockUser,
        mockConfig
      );

      expect((result.annotation.body as any[])[0].value).toBe('Updated Comment');
    });

    it('should throw error when annotation not found', async () => {
      vi.mocked(AnnotationContext.getAnnotation).mockResolvedValue(null);

      await expect(
        AnnotationCrudService.updateAnnotationBody('nonexistent', updateRequest, mockUser, mockConfig)
      ).rejects.toThrow('Annotation not found');
    });

    it('should not add duplicate items (idempotent)', async () => {
      const annotationWithItem = {
        ...mockAnnotation,
        body: [
          { type: 'TextualBody' as const, value: 'Comment 1', format: 'text/plain' as const },
          { type: 'TextualBody' as const, value: 'Comment 2', format: 'text/plain' as const },
        ],
      };
      vi.mocked(AnnotationContext.getAnnotation).mockResolvedValue(annotationWithItem);

      const result = await AnnotationCrudService.updateAnnotationBody(
        'anno-123',
        updateRequest,
        mockUser,
        mockConfig
      );

      // Should not add Comment 2 again
      expect((result.annotation.body as any[]).length).toBe(2);
    });
  });

  describe('deleteAnnotation', () => {
    const mockProjection = {
      annotations: [
        {
          id: 'http://localhost:4000/annotations/anno-123',
          motivation: 'commenting',
          target: { source: 'http://localhost:4000/resources/res-123' },
        },
      ],
    };

    it('should delete annotation successfully', async () => {
      vi.mocked(AnnotationContext.getResourceAnnotations).mockResolvedValue(mockProjection as any);

      await AnnotationCrudService.deleteAnnotation(
        'http://localhost:4000/annotations/anno-123',
        'http://localhost:4000/resources/res-123',
        mockUser,
        mockConfig
      );

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'annotation.removed',
          resourceId: 'res-123',
          payload: expect.objectContaining({
            annotationId: 'anno-123',
          }),
        })
      );
    });

    it('should throw error when annotation not found in resource', async () => {
      vi.mocked(AnnotationContext.getResourceAnnotations).mockResolvedValue({
        annotations: [],
      } as any);

      await expect(
        AnnotationCrudService.deleteAnnotation(
          'http://localhost:4000/annotations/nonexistent',
          'http://localhost:4000/resources/res-123',
          mockUser,
          mockConfig
        )
      ).rejects.toThrow('Annotation not found in resource');
    });

    it('should extract annotation ID from full URI', async () => {
      vi.mocked(AnnotationContext.getResourceAnnotations).mockResolvedValue(mockProjection as any);

      await AnnotationCrudService.deleteAnnotation(
        'http://localhost:4000/annotations/anno-123',
        'http://localhost:4000/resources/res-123',
        mockUser,
        mockConfig
      );

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            annotationId: 'anno-123',
          }),
        })
      );
    });
  });
});
