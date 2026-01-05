import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceOperations, type CreateResourceInput } from '../resource-operations';
import type { EnvironmentConfig } from '@semiont/core';
import type { User } from '@prisma/client';

// Mock dependencies
vi.mock('../event-store-service', () => ({
  createEventStore: vi.fn(),
}));

vi.mock('@semiont/content', () => ({
  FilesystemRepresentationStore: vi.fn(),
}));

vi.mock('../../utils/id-generator', () => ({
  userToAgent: vi.fn(),
}));

vi.mock('../../events/consumers/graph-consumer', () => ({
  getGraphConsumer: vi.fn(),
}));

import { createEventStore } from '../event-store-service';
import { FilesystemRepresentationStore } from '@semiont/content';
import { userToAgent } from '../../utils/id-generator';

describe('ResourceOperations', () => {
  let mockConfig: EnvironmentConfig;
  let mockUser: User;
  let mockEventStore: any;
  let mockRepStore: any;
  let mockGraphConsumer: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        backend: { publicURL: 'http://localhost:4000' },
        filesystem: { path: '/test/data' },
      },
      _metadata: { projectRoot: '/test/project' },
    } as EnvironmentConfig;

    mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
    } as User;

    mockEventStore = {
      appendEvent: vi.fn().mockResolvedValue({ metadata: { sequenceNumber: 1 } }),
    };

    mockRepStore = {
      store: vi.fn().mockResolvedValue({
        checksum: 'abc123',
        byteSize: 100,
        mediaType: 'text/plain',
      }),
    };

    mockGraphConsumer = {
      subscribeToResource: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(createEventStore).mockResolvedValue(mockEventStore);
    vi.mocked(FilesystemRepresentationStore).mockImplementation(() => mockRepStore);
    vi.mocked(userToAgent).mockReturnValue({
      type: 'Person',
      id: 'http://localhost:4000/users/user-123',
      name: 'Test User',
    });
  });

  describe('createResource', () => {
    const validInput: CreateResourceInput = {
      name: 'Test Document',
      content: Buffer.from('Test content'),
      format: 'text/plain',
      language: 'en',
      entityTypes: ['Document'],
      creationMethod: 'api',
    };

    it('should create resource successfully', async () => {
      const result = await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(result.resource.name).toBe('Test Document');
      expect(result.resource.entityTypes).toEqual(['Document']);
      expect(result.resource.creationMethod).toBe('api');
      expect(result.resource.archived).toBe(false);
      expect(result.resource.dateCreated).toBeDefined();
      expect(result.annotations).toEqual([]);
    });

    it('should store content to FilesystemRepresentationStore', async () => {
      await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(FilesystemRepresentationStore).toHaveBeenCalledWith(
        { basePath: '/test/data' },
        '/test/project'
      );
      expect(mockRepStore.store).toHaveBeenCalledWith(
        validInput.content,
        expect.objectContaining({
          mediaType: 'text/plain',
          language: 'en',
          rel: 'original',
        })
      );
    });

    it('should emit resource.created event', async () => {
      await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'resource.created',
          userId: 'user-123',
          payload: expect.objectContaining({
            name: 'Test Document',
            format: 'text/plain',
            contentChecksum: 'abc123',
            contentByteSize: 100,
            creationMethod: 'api',
            entityTypes: ['Document'],
            language: 'en',
            isDraft: false,
          }),
        })
      );
    });

    it('should generate unique resource ID', async () => {
      const result = await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(result.resource['@id']).toMatch(/^http:\/\/localhost:4000\/resources\/.+/);
    });

    it('should include representation metadata in response', async () => {
      const result = await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(result.resource.representations).toHaveLength(1);
      expect(result.resource.representations[0]).toEqual({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 100,
        rel: 'original',
        language: 'en',
      });
    });

    it('should set wasAttributedTo with user agent', async () => {
      const result = await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(result.resource.wasAttributedTo).toEqual({
        type: 'Person',
        id: 'http://localhost:4000/users/user-123',
        name: 'Test User',
      });
    });

    it('should use default creationMethod when not provided', async () => {
      const inputWithoutMethod = { ...validInput, creationMethod: undefined };

      const result = await ResourceOperations.createResource(inputWithoutMethod, mockUser, mockConfig);

      expect(result.resource.creationMethod).toBe('api');
    });

    it('should validate creationMethod', async () => {
      const inputWithInvalidMethod = {
        ...validInput,
        creationMethod: 'invalid' as any,
      };

      const result = await ResourceOperations.createResource(
        inputWithInvalidMethod,
        mockUser,
        mockConfig
      );

      // Should fallback to 'api'
      expect(result.resource.creationMethod).toBe('api');
    });

    it('should accept valid creationMethods', async () => {
      const methods = ['api', 'upload', 'generation', 'clone', 'import'];

      for (const method of methods) {
        const input = { ...validInput, creationMethod: method as any };
        const result = await ResourceOperations.createResource(input, mockUser, mockConfig);
        expect(result.resource.creationMethod).toBe(method);
      }
    });

    it('should default entityTypes to empty array', async () => {
      const inputWithoutTypes = { ...validInput, entityTypes: undefined };

      const result = await ResourceOperations.createResource(inputWithoutTypes, mockUser, mockConfig);

      expect(result.resource.entityTypes).toEqual([]);
    });

    it('should handle content without language', async () => {
      const inputWithoutLang = { ...validInput, language: undefined };

      await ResourceOperations.createResource(inputWithoutLang, mockUser, mockConfig);

      expect(mockRepStore.store).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          language: undefined,
        })
      );
    });

    it('should throw error when backend publicURL not configured', async () => {
      const invalidConfig = {
        services: {
          filesystem: { path: '/test/data' },
        },
      } as EnvironmentConfig;

      await expect(
        ResourceOperations.createResource(validInput, mockUser, invalidConfig)
      ).rejects.toThrow('Backend publicURL not configured');
    });

    it('should set Schema.org context', async () => {
      const result = await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(result.resource['@context']).toBe('https://schema.org/');
    });

    it('should handle multiple entityTypes', async () => {
      const inputWithTypes = {
        ...validInput,
        entityTypes: ['Document', 'Article', 'ScholarlyArticle'],
      };

      const result = await ResourceOperations.createResource(inputWithTypes, mockUser, mockConfig);

      expect(result.resource.entityTypes).toEqual(['Document', 'Article', 'ScholarlyArticle']);
    });

    it('should not include undefined fields in event payload', async () => {
      const inputWithoutOptionals = {
        name: 'Test',
        content: Buffer.from('content'),
        format: 'text/plain' as const,
      };

      await ResourceOperations.createResource(inputWithoutOptionals, mockUser, mockConfig);

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            generatedFrom: undefined,
            generationPrompt: undefined,
          }),
        })
      );
    });

    it('should handle graph consumer subscription failure gracefully', async () => {
      // Mock dynamic import to throw error
      const originalImport = await import('../../events/consumers/graph-consumer');
      vi.doMock('../../events/consumers/graph-consumer', () => ({
        getGraphConsumer: vi.fn().mockRejectedValue(new Error('Graph consumer not available')),
      }));

      // Should not throw error, just log and continue
      await expect(
        ResourceOperations.createResource(validInput, mockUser, mockConfig)
      ).resolves.toBeDefined();
    });

    it('should normalize backend URL (remove trailing slash)', async () => {
      const configWithTrailingSlash = {
        ...mockConfig,
        services: {
          ...mockConfig.services,
          backend: { publicURL: 'http://localhost:4000/' },
        },
      };

      const result = await ResourceOperations.createResource(
        validInput,
        mockUser,
        configWithTrailingSlash
      );

      expect(result.resource['@id']).toMatch(/^http:\/\/localhost:4000\/resources\/.+/);
      expect(result.resource['@id']).not.toContain('//resources');
    });

    it('should store content with correct media type', async () => {
      const pdfInput = {
        ...validInput,
        format: 'application/pdf' as const,
      };

      await ResourceOperations.createResource(pdfInput, mockUser, mockConfig);

      expect(mockRepStore.store).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          mediaType: 'application/pdf',
        })
      );
    });

    it('should include version in event', async () => {
      await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
        })
      );
    });

    it('should set isDraft to false', async () => {
      await ResourceOperations.createResource(validInput, mockUser, mockConfig);

      expect(mockEventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            isDraft: false,
          }),
        })
      );
    });
  });
});
