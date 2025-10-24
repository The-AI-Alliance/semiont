/**
 * Admin API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type { paths } from '@semiont/api-client';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

type AdminUser = ResponseContent<paths['/api/admin/users']['get']>['users'][number];
type AdminUsersResponse = ResponseContent<paths['/api/admin/users']['get']>;
type AdminUserStatsResponse = ResponseContent<paths['/api/admin/users/stats']['get']>;
type UpdateUserRequest = RequestContent<paths['/api/admin/users/{id}']['patch']>;
type OAuthConfigResponse = ResponseContent<paths['/api/admin/oauth/config']['get']>;

export const admin = {
  users: {
    all: {
      useQuery: () => {
        const { data: session } = useSession();
        return useQuery({
          queryKey: QUERY_KEYS.admin.users.all(),
          queryFn: () => fetchAPI<AdminUsersResponse>('/api/admin/users', {}, session?.backendToken),
          enabled: !!session?.backendToken && !!session?.user?.isAdmin,
        });
      },
    },
    stats: {
      useQuery: () => {
        const { data: session } = useSession();
        return useQuery({
          queryKey: QUERY_KEYS.admin.users.stats(),
          queryFn: () => fetchAPI<AdminUserStatsResponse>('/api/admin/users/stats', {}, session?.backendToken),
          enabled: !!session?.backendToken && !!session?.user?.isAdmin,
        });
      },
    },
    update: {
      useMutation: () => {
        const { data: session } = useSession();
        const queryClient = useQueryClient();
        return useMutation({
          mutationFn: ({ id, data }: { id: string; data: UpdateUserRequest }) =>
            fetchAPI<{ success: boolean; user: AdminUser }>(`/api/admin/users/${id}`, {
              method: 'PATCH',
              body: JSON.stringify(data),
            }, session?.backendToken),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.all() });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.stats() });
          },
        });
      },
    },
    delete: {
      useMutation: () => {
        const { data: session } = useSession();
        const queryClient = useQueryClient();
        return useMutation({
          mutationFn: (id: string) =>
            fetchAPI<{ success: boolean; message: string }>(`/api/admin/users/${id}`, {
              method: 'DELETE',
            }, session?.backendToken),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.all() });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.stats() });
          },
        });
      },
    },
  },
  oauth: {
    config: {
      useQuery: () => {
        const { data: session } = useSession();
        return useQuery({
          queryKey: QUERY_KEYS.admin.oauth.config(),
          queryFn: () => fetchAPI<OAuthConfigResponse>('/api/admin/oauth/config', {}, session?.backendToken),
          enabled: !!session?.backendToken && !!session?.user?.isAdmin,
        });
      },
    },
  },
};
