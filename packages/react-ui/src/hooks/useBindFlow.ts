/**
 * useBindFlow - Reference resolution flow hook
 *
 * Activates bind + search orchestration for a resource by delegating to
 * client.flows.bind(). All subscription logic lives in FlowEngine (api-client).
 *
 * Toast notifications for resolution errors remain here (React-specific).
 *
 * @subscribes bind:update-body - Update annotation body via API
 * @subscribes match:search-requested - Bridge to backend Matcher via SSE
 * @emits bind:body-updated, bind:body-update-failed
 */

import { useEffect, useRef } from 'react';
import type { ResourceId } from '@semiont/core';
import { accessToken } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useToast } from '../components/Toast';

export function useBindFlow(rUri: ResourceId): void {
  const client = useApiClient();
  const token = useAuthToken();
  const { showError } = useToast();

  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; });

  useEffect(() => {
    const sub = client.flows.bind(rUri, () =>
      tokenRef.current ? accessToken(tokenRef.current) : undefined
    );
    return () => sub.unsubscribe();
  }, [rUri, client]);

  useEventSubscriptions({
    'bind:body-update-failed': ({ message }) => showError(`Failed to update reference: ${message}`),
  });
}
