'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { ResourceUri } from '@semiont/api-client';

/**
 * Resource event structure from the event store
 */
export interface ResourceEvent {
  id: string;
  type: string;
  timestamp: string;
  userId: string;
  resourceId: string;
  payload: Record<string, any>;
  metadata: {
    sequenceNumber: number;
    prevEventHash?: string;
    checksum?: string;
  };
}

/**
 * Stream connection status
 */
export type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface UseResourceEventsOptions {
  rUri: ResourceUri;
  onEvent?: (event: ResourceEvent) => void;
  onAnnotationAdded?: (event: ResourceEvent) => void;
  onAnnotationRemoved?: (event: ResourceEvent) => void;
  onAnnotationBodyUpdated?: (event: ResourceEvent) => void;
  onEntityTagAdded?: (event: ResourceEvent) => void;
  onEntityTagRemoved?: (event: ResourceEvent) => void;
  onDocumentArchived?: (event: ResourceEvent) => void;
  onDocumentUnarchived?: (event: ResourceEvent) => void;
  onError?: (error: string) => void;
  autoConnect?: boolean; // Default: true
}

/**
 * React hook for subscribing to real-time document events via SSE
 *
 * Opens a long-lived SSE connection to receive events as they happen.
 * Automatically reconnects on disconnect (with exponential backoff).
 *
 * @example
 * ```tsx
 * const { status, connect, disconnect } = useResourceEvents({
 *   rUri: resourceUri('http://localhost:4000/resources/doc-123'),
 *   onAnnotationAdded: (event) => {
 *     console.log('New annotation:', event.payload);
 *     // Update UI to show new annotation (highlight, reference, or assessment)
 *   },
 *   onAnnotationBodyUpdated: (event) => {
 *     console.log('Annotation body updated:', event.payload);
 *     // Update annotation display to reflect body changes
 *   }
 * });
 * ```
 */
export function useResourceEvents({
  rUri,
  onEvent,
  onAnnotationAdded,
  onAnnotationRemoved,
  onAnnotationBodyUpdated,
  onEntityTagAdded,
  onEntityTagRemoved,
  onDocumentArchived,
  onDocumentUnarchived,
  onError,
  autoConnect = true,
}: UseResourceEventsOptions) {
  const { data: session, status: sessionStatus } = useSession();
  const [status, setStatus] = useState<StreamStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<ResourceEvent | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const handleEvent = useCallback((event: ResourceEvent) => {
    setLastEvent(event);
    setEventCount(prev => prev + 1);

    // Call generic handler
    onEvent?.(event);

    // Call specific handlers
    switch (event.type) {
      case 'annotation.added':
        onAnnotationAdded?.(event);
        break;
      case 'annotation.removed':
        onAnnotationRemoved?.(event);
        break;
      case 'annotation.body.updated':
        onAnnotationBodyUpdated?.(event);
        break;
      case 'entitytag.added':
        onEntityTagAdded?.(event);
        break;
      case 'entitytag.removed':
        onEntityTagRemoved?.(event);
        break;
      case 'document.archived':
        onDocumentArchived?.(event);
        break;
      case 'document.unarchived':
        onDocumentUnarchived?.(event);
        break;
    }
  }, [
    onEvent,
    onAnnotationAdded,
    onAnnotationRemoved,
    onAnnotationBodyUpdated,
    onEntityTagAdded,
    onEntityTagRemoved,
    onDocumentArchived,
    onDocumentUnarchived,
  ]);

  const connect = useCallback(async () => {
    console.log(`[ResourceEvents] Attempting to connect to resource ${rUri} events stream`);

    // Close any existing connection
    if (abortControllerRef.current) {
      console.log(`[ResourceEvents] Closing existing connection for ${rUri}`);
      abortControllerRef.current.abort();
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Get auth token from session
    if (!session?.backendToken) {
      console.error(`[ResourceEvents] Cannot connect to ${rUri}: No auth token`);
      onError?.('Authentication required');
      setStatus('error');
      return;
    }

    console.log(`[ResourceEvents] Connecting to SSE stream for resource ${rUri}`);
    setStatus('connecting');

    // Create new abort controller
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build SSE URL - rUri is already the full resource URI
    const url = `${rUri}/events/stream`;

    try {
      await fetchEventSource(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${session.backendToken}`,
        },
        signal: abortController.signal,

        async onopen(response) {
          if (response.ok) {
            console.log(`[ResourceEvents] Successfully connected to resource ${rUri} events stream`);
            setStatus('connected');
            reconnectAttemptsRef.current = 0; // Reset reconnect counter
          } else {
            console.error(`[ResourceEvents] Failed to open stream for ${rUri}: ${response.status}`);
            throw new Error(`Failed to open stream: ${response.status}`);
          }
        },

        onmessage(msg) {
          // Ignore keep-alive messages
          if (msg.data === ':keep-alive') {
            return;
          }

          // Handle stream-connected event
          if (msg.event === 'stream-connected') {
            console.log(`[ResourceEvents] Stream connected event received for ${rUri}`);
            return;
          }

          console.log(`[ResourceEvents] Received event for document ${rUri}:`, msg.event);

          // Handle document events
          try {
            const event = JSON.parse(msg.data) as ResourceEvent;
            handleEvent(event);
          } catch (error) {
            console.error('[ResourceEvents] Failed to parse event:', error, msg.data);
          }
        },

        onerror(err) {
          // If manually aborted, don't reconnect
          if (abortController.signal.aborted) {
            return;
          }

          setStatus('error');

          // Don't retry on 404 - document doesn't exist
          if (err instanceof Error && err.message.includes('404')) {
            console.error(`[ResourceEvents] Document ${rUri} not found (404). Stopping reconnection attempts.`);
            onError?.('Document not found');
            throw err;
          }

          // Exponential backoff for reconnection
          reconnectAttemptsRef.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000);

          console.log(`[ResourceEvents] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            if (!abortController.signal.aborted) {
              connect();
            }
          }, delay);

          throw err; // Throw to stop automatic reconnection by fetchEventSource
        },

        openWhenHidden: true, // Keep connection open when tab is in background
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        // Don't log 404s - already handled in onerror
        if (!(error instanceof Error && error.message.includes('404'))) {
          console.error('[ResourceEvents] Failed to connect:', error);
          setStatus('error');
          onError?.('Failed to connect to event stream');
        }
      }
    }
  }, [rUri, handleEvent, onError, session]);

  const disconnect = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setStatus('disconnected');
    reconnectAttemptsRef.current = 0;
  }, []);

  // Auto-connect on mount if enabled and authenticated
  useEffect(() => {
    if (autoConnect && sessionStatus === 'authenticated') {
      connect();
    }

    // Cleanup on unmount
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, sessionStatus]); // Only reconnect when auth status or autoConnect changes, not when connect/disconnect change

  return {
    status,
    lastEvent,
    eventCount,
    connect,
    disconnect,
    isConnected: status === 'connected',
  };
}