'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { SSEStream } from '@semiont/api-client';
import { accessToken } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useEventBus } from '../contexts/EventBusContext';
import type { StreamStatus } from './useResourceEvents';

/**
 * React hook for subscribing to global system-level events via SSE
 *
 * Opens a long-lived SSE connection to GET /api/events/stream to receive
 * domain events that are not scoped to a specific resource (e.g., entity type changes).
 *
 * Automatically invalidates relevant React Query caches when system events arrive.
 *
 * @example
 * ```tsx
 * // In your app layout:
 * useGlobalEvents(); // That's it — auto-connects and invalidates queries
 * ```
 */
export function useGlobalEvents({ autoConnect = true }: { autoConnect?: boolean } = {}) {
  const semiont = useApiClient();
  const token = useAuthToken();
  const eventBus = useEventBus();
  const [status, setStatus] = useState<StreamStatus>('disconnected');
  const streamRef = useRef<SSEStream | null>(null);
  const connectingRef = useRef(false);

  const connect = useCallback(async () => {
    if (connectingRef.current || streamRef.current) return;
    connectingRef.current = true;

    if (!semiont) {
      setStatus('error');
      connectingRef.current = false;
      return;
    }

    setStatus('connecting');

    try {
      const stream = semiont.sse.globalEvents({
        ...(token ? { auth: accessToken(token) } : {}),
        eventBus,
      });
      streamRef.current = stream;
      setStatus('connected');
      connectingRef.current = false;
    } catch (error) {
      console.error('[GlobalEvents] Failed to connect:', error);
      setStatus('error');
      connectingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semiont, token, eventBus]);

  const disconnect = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    setStatus('disconnected');
    connectingRef.current = false;
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect && semiont) {
      connect();
    }
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, semiont]);

  return {
    status,
    connect,
    disconnect,
    isConnected: status === 'connected',
  };
}
