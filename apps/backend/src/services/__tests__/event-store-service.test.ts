import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventStore, createEventQuery, createEventValidator } from '../event-store-service';
import type { EnvironmentConfig } from '@semiont/core';
import { EventStore, EventQuery, EventValidator, FilesystemViewStorage } from '@semiont/event-sourcing';

// Mock dependencies
vi.mock('@semiont/event-sourcing', () => ({
  EventStore: vi.fn(),
  EventQuery: vi.fn(),
  EventValidator: vi.fn(),
  FilesystemViewStorage: vi.fn(),
}));

describe('EventStoreService', () => {
  let mockConfig: EnvironmentConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        backend: { publicURL: 'http://localhost:4000' },
        filesystem: { path: '/test/data' },
      },
      _metadata: { projectRoot: '/test/project' },
    } as EnvironmentConfig;
  });

  describe('createEventStore', () => {
    it('should create EventStore with resolved absolute path', async () => {
      vi.mocked(FilesystemViewStorage).mockImplementation(() => ({} as any));
      vi.mocked(EventStore).mockImplementation(() => ({} as any));

      await createEventStore(mockConfig);

      expect(FilesystemViewStorage).toHaveBeenCalledWith('/test/data', '/test/project');
      expect(EventStore).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: '/test/data',
          dataDir: '/test/data/events',
          enableSharding: true,
          numShards: 65536,
        }),
        expect.any(Object), // viewStorage
        expect.objectContaining({
          baseUrl: 'http://localhost:4000',
        })
      );
    });

    it('should resolve relative path against project root', async () => {
      mockConfig.services.filesystem!.path = 'data/storage';
      vi.mocked(FilesystemViewStorage).mockImplementation(() => ({} as any));
      vi.mocked(EventStore).mockImplementation(() => ({} as any));

      await createEventStore(mockConfig);

      expect(EventStore).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: '/test/project/data/storage',
          dataDir: '/test/project/data/storage/events',
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should accept custom basePath in config', async () => {
      vi.mocked(FilesystemViewStorage).mockImplementation(() => ({} as any));
      vi.mocked(EventStore).mockImplementation(() => ({} as any));

      await createEventStore(mockConfig, { basePath: '/custom/path' });

      expect(EventStore).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: '/custom/path',
          dataDir: '/custom/path/events',
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should throw error when basePath not provided', async () => {
      const invalidConfig = {
        services: {
          backend: { publicURL: 'http://localhost:4000' },
        },
      } as EnvironmentConfig;

      await expect(createEventStore(invalidConfig)).rejects.toThrow(
        'basePath must be provided via config or envConfig.services.filesystem.path'
      );
    });

    it('should throw error when backend publicURL not configured', async () => {
      const invalidConfig = {
        services: {
          filesystem: { path: '/test/data' },
        },
      } as EnvironmentConfig;

      await expect(createEventStore(invalidConfig)).rejects.toThrow(
        'Backend publicURL not found in configuration'
      );
    });

    it('should pass custom config options to EventStore', async () => {
      vi.mocked(FilesystemViewStorage).mockImplementation(() => ({} as any));
      vi.mocked(EventStore).mockImplementation(() => ({} as any));

      await createEventStore(mockConfig, {
        enableSharding: false,
      });

      expect(EventStore).toHaveBeenCalledWith(
        expect.objectContaining({
          enableSharding: false,
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should create FilesystemViewStorage with correct parameters', async () => {
      vi.mocked(FilesystemViewStorage).mockImplementation(() => ({} as any));
      vi.mocked(EventStore).mockImplementation(() => ({} as any));

      await createEventStore(mockConfig);

      expect(FilesystemViewStorage).toHaveBeenCalledWith(
        '/test/data',
        '/test/project'
      );
    });

    it('should use default sharding configuration', async () => {
      vi.mocked(FilesystemViewStorage).mockImplementation(() => ({} as any));
      vi.mocked(EventStore).mockImplementation(() => ({} as any));

      await createEventStore(mockConfig);

      expect(EventStore).toHaveBeenCalledWith(
        expect.objectContaining({
          enableSharding: true,
          numShards: 65536,
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should handle config without projectRoot', async () => {
      const configWithoutRoot = {
        services: {
          backend: { publicURL: 'http://localhost:4000' },
          filesystem: { path: 'relative/path' },
        },
      } as EnvironmentConfig;

      vi.mocked(FilesystemViewStorage).mockImplementation(() => ({} as any));
      vi.mocked(EventStore).mockImplementation(() => ({} as any));

      await createEventStore(configWithoutRoot);

      // Should resolve against cwd when no projectRoot
      expect(EventStore).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: expect.any(String),
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe('createEventQuery', () => {
    it('should create EventQuery with storage from EventStore', () => {
      const mockStorage = { read: vi.fn() };
      const mockEventStore = {
        log: {
          storage: mockStorage,
        },
      } as any;

      vi.mocked(EventQuery).mockImplementation(() => ({} as any));

      createEventQuery(mockEventStore);

      expect(EventQuery).toHaveBeenCalledWith(mockStorage);
    });

    it('should return EventQuery instance', () => {
      const mockEventQuery = { query: vi.fn() };
      const mockEventStore = {
        log: {
          storage: {},
        },
      } as any;

      vi.mocked(EventQuery).mockReturnValue(mockEventQuery as any);

      const result = createEventQuery(mockEventStore);

      expect(result).toBe(mockEventQuery);
    });
  });

  describe('createEventValidator', () => {
    it('should create EventValidator instance', () => {
      vi.mocked(EventValidator).mockImplementation(() => ({} as any));

      createEventValidator();

      expect(EventValidator).toHaveBeenCalled();
    });

    it('should return EventValidator instance', () => {
      const mockValidator = { validate: vi.fn() };
      vi.mocked(EventValidator).mockReturnValue(mockValidator as any);

      const result = createEventValidator();

      expect(result).toBe(mockValidator);
    });

    it('should create new instance on each call', () => {
      vi.mocked(EventValidator).mockImplementation(() => ({} as any));

      createEventValidator();
      createEventValidator();

      expect(EventValidator).toHaveBeenCalledTimes(2);
    });
  });
});
