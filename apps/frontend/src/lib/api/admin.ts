/**
 * Admin API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type {
  AdminUser,
  AdminUsersResponse,
  AdminUserStatsResponse,
  UpdateUserRequest,
  OAuthConfigResponse,
} from './types';

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
