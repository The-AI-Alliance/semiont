import { useQuery, useMutation } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type { paths } from '@semiont/api-client';
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type AcceptTermsResponse = ResponseContent<paths['/api/users/accept-terms']['post']>;

export const auth = {
  me: {
    useQuery: () => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.auth.me(),
        queryFn: () => fetchAPI<any>('/api/auth/me', {}, session?.backendToken),
        enabled: !!session?.backendToken,
      });
    },
  },
  acceptTerms: {
    useMutation: () => {
      const { data: session } = useSession();
      return useMutation({
        mutationFn: () =>
          fetchAPI<AcceptTermsResponse>('/api/users/accept-terms', {
            method: 'POST',
          }, session?.backendToken),
      });
    },
  },
  logout: {
    useMutation: () => {
      const { data: session } = useSession();
      return useMutation({
        mutationFn: () => fetchAPI<void>('/api/auth/logout', { method: 'POST' }, session?.backendToken),
      });
    },
  },
  google: {
    useMutation: () => {
      return useMutation({
        mutationFn: (data: { access_token: string }) =>
          fetchAPI<{ success: boolean; user: any; token: string; isNewUser: boolean }>('/api/tokens/google', {
            method: 'POST',
            body: JSON.stringify(data),
          }),
      });
    },
  },
};
