'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { ResourceUri, ResourceEvent as ApiResourceEvent, SSEStream } from '@semiont/api-client';
import { useApiClient } from '../lib/api-hooks';

/**
 * Resource event structure from the event store
 * (Re-exported from api-client for consistency)
 */
export type ResourceEvent = ApiResourceEvent;

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
  const client = useApiClient();
  const [status, setStatus] = useState<StreamStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<ResourceEvent | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const streamRef = useRef<SSEStream<ApiResourceEvent, never> | null>(null);
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

    // Close any existing stream
    if (streamRef.current) {
      console.log(`[ResourceEvents] Closing existing connection for ${rUri}`);
      streamRef.current.close();
      streamRef.current = null;
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Check if client is available
    if (!client) {
      console.error(`[ResourceEvents] Cannot connect to ${rUri}: No API client available`);
      onError?.('Authentication required');
      setStatus('error');
      return;
    }

    console.log(`[ResourceEvents] Connecting to SSE stream for resource ${rUri}`);
    setStatus('connecting');

    try {
      // Start SSE stream using api-client
      const stream = client.sse.resourceEvents(rUri);
      streamRef.current = stream;

      // Handle progress events (all resource events)
      stream.onProgress((event) => {
        // Ignore keep-alive messages (if they come through as events)
        if (event.type === 'keep-alive') {
          return;
        }

        // Handle stream-connected event
        if (event.type === 'stream-connected') {
          console.log(`[ResourceEvents] Stream connected event received for ${rUri}`);
          setStatus('connected');
          reconnectAttemptsRef.current = 0; // Reset reconnect counter
          return;
        }

        console.log(`[ResourceEvents] Received event for document ${rUri}:`, event.type);
        handleEvent(event);
      });

      // Handle errors and reconnection
      stream.onError((error) => {
        console.error(`[ResourceEvents] Stream error for ${rUri}:`, error);
        setStatus('error');

        // Don't retry on 404 - document doesn't exist
        if (error.message.includes('404')) {
          console.error(`[ResourceEvents] Document ${rUri} not found (404). Stopping reconnection attempts.`);
          onError?.('Document not found');
          streamRef.current = null;
          return;
        }

        // Exponential backoff for reconnection
        reconnectAttemptsRef.current++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000);

        console.log(`[ResourceEvents] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);

        reconnectTimeoutRef.current = setTimeout(() => {
          if (!streamRef.current) {
            // Reconnect - call connect directly to avoid circular dependency
            connect();
          }
        }, delay);
      });
    } catch (error) {
      console.error('[ResourceEvents] Failed to connect:', error);
      setStatus('error');
      onError?.('Failed to connect to event stream');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rUri, handleEvent, onError, client]);

  const disconnect = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setStatus('disconnected');
    reconnectAttemptsRef.current = 0;
  }, []);

  // Auto-connect on mount if enabled and client is available
  useEffect(() => {
    if (autoConnect && client) {
      connect();
    }

    // Cleanup on unmount
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, client]); // Only reconnect when client availability or autoConnect changes, not when connect/disconnect change

  return {
    status,
    lastEvent,
    eventCount,
    connect,
    disconnect,
    isConnected: status === 'connected',
  };
}