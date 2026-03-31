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
import { SemiontApiClient } from '@semiont/api-client';
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
import { EventBusProvider } from '../../contexts/EventBusContext';

// Mock the API client
vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(function() {}),
  resourceId: vi.fn(function(id: string) { return id as any; }),
  annotationId: vi.fn(function(id: string) { return id as any; }),
  searchQuery: vi.fn(function(q: string) { return q as any; }),
  cloneToken: vi.fn(function(t: string) { return t as any; }),
  entityType: vi.fn(function(t: string) { return t as any; }),
  userDID: vi.fn(function(id: string) { return id as any; }),
  accessToken: vi.fn(function(t: string) { return t as any; }),
  baseUrl: vi.fn(function(url: string) { return url; }),
}));

describe('API Hooks Authentication', () => {
  let mockClient: any;
  let queryClient: QueryClient;

  beforeEach(() => {
    // Create mock client with all methods
    mockClient = {
      // Resources
      browseResources: vi.fn().mockResolvedValue({ resources: [] }),
      browseResource: vi.fn().mockResolvedValue({ resource: {} }),
      getResourceEvents: vi.fn().mockResolvedValue({ events: [] }),
      browseAnnotations: vi.fn().mockResolvedValue({ annotations: [] }),
      browseReferences: vi.fn().mockResolvedValue({ references: [] }),
      getResourceByToken: vi.fn().mockResolvedValue({ resource: {} }),
      yieldResource: vi.fn().mockResolvedValue({ resourceId: 'test-id' }),
      updateResource: vi.fn().mockResolvedValue(undefined),
      generateCloneToken: vi.fn().mockResolvedValue({ token: 'clone-token' }),
      createResourceFromToken: vi.fn().mockResolvedValue({ resourceId: 'test-id' }),

      // Annotations
      getAnnotation: vi.fn().mockResolvedValue({ annotation: {} }),
      browseAnnotation: vi.fn().mockResolvedValue({ annotation: {} }),
      getAnnotationHistory: vi.fn().mockResolvedValue({ history: [] }),
      markAnnotation: vi.fn().mockResolvedValue({ annotationId: 'test-id' }),
      deleteAnnotation: vi.fn().mockResolvedValue(undefined),
      bindAnnotation: vi.fn().mockResolvedValue(undefined),

      // Entity Types
      listEntityTypes: vi.fn().mockResolvedValue({ entityTypes: [] }),
      addEntityType: vi.fn().mockResolvedValue(undefined),
      addEntityTypesBulk: vi.fn().mockResolvedValue(undefined),

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

      // Stores (used by mutation onSuccess handlers)
      stores: {
        resources: {
          invalidateDetail: vi.fn(),
          invalidateLists: vi.fn(),
        },
        annotations: {
          invalidateDetail: vi.fn(),
        },
      },
    };

    vi.mocked(SemiontApiClient).mockImplementation(function() { return mockClient; });

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
    <EventBusProvider>
      <AuthTokenProvider token="test-token">
        <ApiClientProvider baseUrl="">
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </ApiClientProvider>
      </AuthTokenProvider>
    </EventBusProvider>
  );

  describe('useResources queries', () => {
    it('should pass auth token to browseResources', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.list.useQuery(), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.browseResources).toHaveBeenCalledWith(
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

      expect(mockClient.browseResource).toHaveBeenCalledWith(
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

    it('should pass auth token to browseAnnotations', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.annotations.useQuery('resource-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.browseAnnotations).toHaveBeenCalledWith(
        'resource-1',
        undefined,
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to browseReferences', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const query = renderHook(() => result.current.referencedBy.useQuery('resource-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.browseReferences).toHaveBeenCalledWith(
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

      expect(mockClient.browseResources).toHaveBeenCalledWith(
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

    it('should pass auth token to browseAnnotation', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const query = renderHook(() => result.current.browseAnnotation.useQuery('resource-1' as any, 'annotation-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.browseAnnotation).toHaveBeenCalledWith(
        'resource-1',
        'annotation-1',
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to getAnnotationHistory', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const query = renderHook(() => result.current.history.useQuery('resource-1' as any, 'annotation-1' as any), { wrapper });

      await waitFor(() => expect(query.result.current.isSuccess).toBe(true));

      expect(mockClient.getAnnotationHistory).toHaveBeenCalledWith(
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
    it('should pass auth token to yieldResource', async () => {
      const { result } = renderHook(() => useResources(), { wrapper });
      const mutation = renderHook(() => result.current.create.useMutation(), { wrapper });

      await mutation.result.current.mutateAsync({
        name: 'test',
        file: new File([], 'test.txt'),
        format: 'text/plain',
        entityTypes: [],
        creationMethod: 'ui',
        storageUri: 'file:///test.txt',
      });

      expect(mockClient.yieldResource).toHaveBeenCalledWith(
        expect.any(Object),
        { auth: 'test-token' }
      );
    });

    it('should pass auth token to markAnnotation', async () => {
      const { result } = renderHook(() => useAnnotations(), { wrapper });
      const mutation = renderHook(() => result.current.create.useMutation(), { wrapper });

      const markData = {
        motivation: 'highlighting' as const,
        target: { source: 'resource-1', selector: { type: 'TextQuoteSelector' as const, exact: 'hello' } },
        body: [{ type: 'TextualBody' as const, value: 'test' }],
      };

      await mutation.result.current.mutateAsync({
        resourceId: 'resource-1' as any,
        data: markData,
      });

      expect(mockClient.markAnnotation).toHaveBeenCalledWith(
        'resource-1',
        markData,
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

      expect(mockClient.browseResources).toHaveBeenLastCalledWith(
        undefined,
        undefined,
        undefined,
        { auth: 'test-token' }
      );

      mockClient.browseResources.mockClear();

      // Rerender with new token
      const wrapperWithNewToken = ({ children }: { children: React.ReactNode }) => (
        <EventBusProvider>
          <AuthTokenProvider token="new-token">
            <ApiClientProvider baseUrl="">
              <QueryClientProvider client={queryClient}>
                {children}
              </QueryClientProvider>
            </ApiClientProvider>
          </AuthTokenProvider>
        </EventBusProvider>
      );

      const query2 = renderHook(() => useResources().list.useQuery(), { wrapper: wrapperWithNewToken });
      await waitFor(() => expect(query2.result.current.isSuccess).toBe(true));

      // Should use new token
      expect(mockClient.browseResources).toHaveBeenLastCalledWith(
        undefined,
        undefined,
        undefined,
        { auth: 'new-token' }
      );
    });
  });
});
