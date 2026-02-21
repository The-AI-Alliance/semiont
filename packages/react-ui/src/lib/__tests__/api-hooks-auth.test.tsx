/**
 * API Hooks Authentication Tests
 *
 * These tests ensure that ALL API operations (queries and mutations) pass
 * authentication tokens correctly. This prevents regressions where auth
 * tokens are accidentally omitted from API calls.
 *
 * Context: We had a bug where all query operations were missing auth tokens,
 * causing 401 errors. These tests prevent that from happening again.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { SemiontApiClient } from '@semiont/core';
import {
  useResources,
  useAnnotations,
  useEntityTypes,
  useAdmin,
  useAuthApi,
  useHealth,
} from '../api-hooks';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';

// Mock the API client
vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(),
  resourceUri: vi.fn((id: string) => id as any),
  annotationUri: vi.fn((id: string) => id as any),
  resourceAnnotationUri: vi.fn((id: string) => id as any),
  searchQuery: vi.fn((q: string) => q as any),
  cloneToken: vi.fn((t: string) => t as any),
  entityType: vi.fn((t: string) => t as any),
  userDID: vi.fn((id: string) => id as any),
  accessToken: vi.fn((t: string) => t as any),
  baseUrl: vi.fn((url: string) => url),
}));

describe('API Hooks Authentication', () => {
  let mockClient: any;
  let queryClient: QueryClient;

  beforeEach(() => {
    // Create mock client with all methods
    mockClient = {
      // Resources
      listResources: vi.fn().mockResolvedValue({ resources: [] }),
      getResource: vi.fn().mockResolvedValue({ resource: {} }),
      getResourceEvents: vi.fn().mockResolvedValue({ events: [] }),
      getResourceAnnotations: vi.fn().mockResolvedValue({ annotations: [] }),
      getResourceReferencedBy: vi.fn().mockResolvedValue({ references: [] }),
      getResourceByToken: vi.fn().mockResolvedValue({ resource: {} }),
      createResource: vi.fn().mockResolvedValue({ resource: {} }),
      updateResource: vi.fn().mockResolvedValue({ resource: {} }),
      generateCloneToken: vi.fn().mockResolvedValue({ token: 'clone-token' }),
      createResourceFromToken: vi.fn().mockResolvedValue({ resource: {} }),

      // Annotations
      getAnnotation: vi.fn().mockResolvedValue({ annotation: {} }),
      getResourceAnnotation: vi.fn().mockResolvedValue({ annotation: {} }),
      getAnnotationHistory: vi.fn().mockResolvedValue({ history: [] }),
      getAnnotationLLMContext: vi.fn().mockResolvedValue({ context: {} }),
      createAnnotation: vi.fn().mockResolvedValue({ annotation: {} }),
      deleteAnnotation: vi.fn().mockResolvedValue({}),
      updateAnnotationBody: vi.fn().mockResolvedValue({ annotation: {} }),

      // Entity Types
      listEntityTypes: vi.fn().mockResolvedValue({ entityTypes: [] }),
      addEntityType: vi.fn().mockResolvedValue({}),
      addEntityTypesBulk: vi.fn().mockResolvedValue({}),

      // Admin
      listUsers: vi.fn().mockResolvedValue({ users: [] }),
      getUserStats: vi.fn().mockResolvedValue({ stats: {} }),
      updateUser: vi.fn().mockResolvedValue({ user: {} }),
      getOAuthConfig: vi.fn().mockResolvedValue({ config: {} }),

      // Auth
      getMe: vi.fn().mockResolvedValue({ user: {} }),
      acceptTerms: vi.fn().mockResolvedValue({}),
      generateMCPToken: vi.fn().mockResolvedValue({ token: 'mcp-token' }),
      logout: vi.fn().mockResolvedValue({}),

      // Health
      healthCheck: vi.fn().mockResolvedValue({ status: 'ok' }),
      getStatus: vi.fn().mockResolvedValue({ status: 'operational' }),
    };

    vi.mocked(SemiontApiClient).mockImplementation(() => mockClient);

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthTokenProvider token="test-token">
      <ApiClientProvider baseUrl="">
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </ApiClientProvider>
    </AuthTokenProvider>
  );

  describe('useResources queries', () => {
    it('should pass auth token to listResources', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.list.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.listResources).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getResource', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.get.useQuery('resource-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getResource).toHaveBeenCalledWith(
        'resource-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getResourceEvents', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.events.useQuery('resource-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getResourceEvents).toHaveBeenCalledWith(
        'resource-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getResourceAnnotations', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.annotations.useQuery('resource-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getResourceAnnotations).toHaveBeenCalledWith(
        'resource-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getResourceReferencedBy', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.referencedBy.useQuery('resource-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getResourceReferencedBy).toHaveBeenCalledWith(
        'resource-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getResourceByToken', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.getByToken.useQuery('clone-token'), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getResourceByToken).toHaveBeenCalledWith(
        'clone-token',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to search', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.search.useQuery('test', 10), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.listResources).toHaveBeenCalledWith(
        10,
        undefined,
        'test',
        { auth: 'test-token' }
      );
    });
  });

  describe('useAnnotations queries', () => {
    it('should pass auth token to getAnnotation', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const query = renderHook(() => result.current.get.useQuery('annotation-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getAnnotation).toHaveBeenCalledWith(
        'annotation-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getResourceAnnotation', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const query = renderHook(() => result.current.getResourceAnnotation.useQuery('annotation-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getResourceAnnotation).toHaveBeenCalledWith(
        'annotation-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getAnnotationHistory', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const query = renderHook(() => result.current.history.useQuery('annotation-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getAnnotationHistory).toHaveBeenCalledWith(
        'annotation-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getAnnotationLLMContext', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const query = renderHook(
        () => result.current.llmContext.useQuery('resource-1' as any, 'annotation-1'),
        { wrapper }
      );

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getAnnotationLLMContext).toHaveBeenCalledWith(
        'resource-1',
        'annotation-1',
        { auth: 'test-token' }
      );
    });
  });

  describe('useEntityTypes queries', () => {
    it('should pass auth token to listEntityTypes', async () => {
      const { result } = renderHook(() => useEntityTypes(), { wrapper });
      const query = renderHook(() => result.current.list.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.listEntityTypes).toHaveBeenCalledWith(
        { auth: 'test-token' }
      );
    });
  });

  describe('useAdmin queries', () => {
    it('should pass auth token to listUsers', async () => {
      const { result } = renderHook(() => useAdmin(), { wrapper });
      const query = renderHook(() => result.current.users.list.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.listUsers).toHaveBeenCalledWith(
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getUserStats', async () => {
      const { result } = renderHook(() => useAdmin(), { wrapper });
      const query = renderHook(() => result.current.users.stats.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getUserStats).toHaveBeenCalledWith(
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getOAuthConfig', async () => {
      const { result } = renderHook(() => useAdmin(), { wrapper });
      const query = renderHook(() => result.current.oauth.config.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getOAuthConfig).toHaveBeenCalledWith(
        { auth: 'test-token' }
      );
    });
  });

  describe('useAuthApi queries', () => {
    it('should pass auth token to getMe', async () => {
      const { result } = renderHook(() => useAuthApi(), { wrapper });
      const query = renderHook(() => result.current.me.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getMe).toHaveBeenCalledWith(
        { auth: 'test-token' }
      );
    });
  });

  describe('useHealth queries', () => {
    it('should NOT pass auth token to healthCheck (public endpoint)', async () => {
      const { result } = renderHook(() => useHealth(), { wrapper });
      const query = renderHook(() => result.current.check.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      // Health check is public - should NOT have auth
      expect(mockClient.healthCheck).toHaveBeenCalledWith();
    });

    it('should pass auth token to getStatus (authenticated endpoint)', async () => {
      const { result } = renderHook(() => useHealth(), { wrapper });
      const query = renderHook(() => result.current.status.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      // Status requires auth - should have auth token
      expect(mockClient.getStatus).toHaveBeenCalledWith(
        { auth: 'test-token' }
      );
    });
  });

  describe('Mutations also pass auth tokens', () => {
    it('should pass auth token to createResource', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const mutation = renderHook(() => result.current.create.useMutation(), { wrapper });

      await mutation.result.current.mutateAsync({
        name: 'test',
        file: new File([], 'test.txt'),
        format: 'text/plain',
        entityTypes: [],
        creationMethod: 'ui',
      });

      expect(mockClient.createResource).toHaveBeenCalledWith(
        expect.any(Object),
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to createAnnotation', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const mutation = renderHook(() => result.current.create.useMutation(), { wrapper });

      await mutation.result.current.mutateAsync({
        rUri: 'resource-1' as any,
        data: { body: [] },
      });

      expect(mockClient.createAnnotation).toHaveBeenCalledWith(
        'resource-1',
        { body: [] },
        { auth: 'test-token' }
      );
    });
  });

  describe('Auth token reactivity', () => {
    it('should use updated token when token changes', async () => {
      const { rerender } = renderHook(() => useResources(), { wrapper });

      // First render with 'test-token'
      const query1 = renderHook(() => useResources().list.useQuery(), { wrapper });
      await waitFor(() => expect(query1.result.current.isSuccess).toBe(true));

      expect(mockClient.listResources).toHaveBeenLastCalledWith(
        undefined,
        undefined,
        undefined,
        { auth: 'test-token' }
      );

      mockClient.listResources.mockClear();

      // Rerender with new token
      const wrapperWithNewToken = ({ children }: { children: React.ReactNode }) => (
        <AuthTokenProvider token="new-token">
          <ApiClientProvider baseUrl="">
            <QueryClientProvider client={queryClient}>
              {children}
            </QueryClientProvider>
          </ApiClientProvider>
        </AuthTokenProvider>
      );

      const query2 = renderHook(() => useResources().list.useQuery(), { wrapper: wrapperWithNewToken });
      await waitFor(() => expect(query2.result.current.isSuccess).toBe(true));

      // Should use new token
      expect(mockClient.listResources).toHaveBeenLastCalledWith(
        undefined,
        undefined,
        undefined,
        { auth: 'new-token' }
      );
    });
  });
});
