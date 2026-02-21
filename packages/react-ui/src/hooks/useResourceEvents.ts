'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { ResourceUri } from '@semiont/core';
import { SSEStream } from '@semiont/api-client';
import { accessToken } from '@semiont/core';
import type { ResourceEvent } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useEventBus } from '../contexts/EventBusContext';

/**
 * Stream connection status
 */
export type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface UseResourceEventsOptions {
  rUri: ResourceUri;
  onEvent?: (event: ResourceEvent) => void;
  onAnnotationAdded?: (event: Extract<ResourceEvent, { type: 'annotation.added' }>) => void;
  onAnnotationRemoved?: (event: Extract<ResourceEvent, { type: 'annotation.removed' }>) => void;
  onAnnotationBodyUpdated?: (event: Extract<ResourceEvent, { type: 'annotation.body.updated' }>) => void;
  onEntityTagAdded?: (event: Extract<ResourceEvent, { type: 'entitytag.added' }>) => void;
  onEntityTagRemoved?: (event: Extract<ResourceEvent, { type: 'entitytag.removed' }>) => void;
  onDocumentArchived?: (event: Extract<ResourceEvent, { type: 'resource.archived' }>) => void;
  onDocumentUnarchived?: (event: Extract<ResourceEvent, { type: 'resource.unarchived' }>) => void;
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
  const token = useAuthToken();
  const eventBus = useEventBus();
  const [status, setStatus] = useState<StreamStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<ResourceEvent | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const streamRef = useRef<SSEStream | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectingRef = useRef(false);

  // Event Handler Refs Pattern: Store event handlers in refs to prevent reconnection
  // when parent component passes new function references on re-render
  const onEventRef = useRef(onEvent);
  const onAnnotationAddedRef = useRef(onAnnotationAdded);
  const onAnnotationRemovedRef = useRef(onAnnotationRemoved);
  const onAnnotationBodyUpdatedRef = useRef(onAnnotationBodyUpdated);
  const onEntityTagAddedRef = useRef(onEntityTagAdded);
  const onEntityTagRemovedRef = useRef(onEntityTagRemoved);
  const onDocumentArchivedRef = useRef(onDocumentArchived);
  const onDocumentUnarchivedRef = useRef(onDocumentUnarchived);
  const onErrorRef = useRef(onError);

  // Sync refs with latest props on every render
  useEffect(() => {
    onEventRef.current = onEvent;
    onAnnotationAddedRef.current = onAnnotationAdded;
    onAnnotationRemovedRef.current = onAnnotationRemoved;
    onAnnotationBodyUpdatedRef.current = onAnnotationBodyUpdated;
    onEntityTagAddedRef.current = onEntityTagAdded;
    onEntityTagRemovedRef.current = onEntityTagRemoved;
    onDocumentArchivedRef.current = onDocumentArchived;
    onDocumentUnarchivedRef.current = onDocumentUnarchived;
    onErrorRef.current = onError;
  });

  const handleEvent = useCallback((event: ResourceEvent) => {
    setLastEvent(event);
    setEventCount(prev => prev + 1);

    // Call generic handler using ref (always latest)
    onEventRef.current?.(event);

    // Call specific handlers using refs (always latest)
    switch (event.type) {
      case 'annotation.added':
        onAnnotationAddedRef.current?.(event);
        break;
      case 'annotation.removed':
        onAnnotationRemovedRef.current?.(event);
        break;
      case 'annotation.body.updated':
        onAnnotationBodyUpdatedRef.current?.(event);
        break;
      case 'entitytag.added':
        onEntityTagAddedRef.current?.(event);
        break;
      case 'entitytag.removed':
        onEntityTagRemovedRef.current?.(event);
        break;
      case 'resource.archived':
        onDocumentArchivedRef.current?.(event);
        break;
      case 'resource.unarchived':
        onDocumentUnarchivedRef.current?.(event);
        break;
    }
  }, []); // Empty deps - stable reference prevents reconnection!

  // Subscribe to EventBus for resource events
  useEffect(() => {
    const subscription = eventBus.get('make-meaning:event').subscribe((event: ResourceEvent) => {
      handleEvent(event);
    });

    return () => subscription.unsubscribe();
  }, [eventBus, handleEvent]);

  const connect = useCallback(async () => {
    // Prevent duplicate connections
    if (connectingRef.current || streamRef.current) {
      return;
    }

    connectingRef.current = true;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Check if client is available
    if (!client) {
      console.error(`[ResourceEvents] Cannot connect to ${rUri}: No API client available`);
      onErrorRef.current?.('Authentication required');
      setStatus('error');
      connectingRef.current = false;
      return;
    }

    setStatus('connecting');

    try {
      // Start SSE stream - events auto-emit to EventBus
      const stream = client.sse.resourceEvents(rUri, {
        ...(token ? { auth: accessToken(token) } : {}),
        eventBus, // ← Stream auto-emits to EventBus
      });
      streamRef.current = stream;

      // Set connected status
      setStatus('connected');
      reconnectAttemptsRef.current = 0;
      connectingRef.current = false;
    } catch (error) {
      console.error('[ResourceEvents] Failed to connect:', error);
      setStatus('error');
      onErrorRef.current?.('Failed to connect to event stream');
      connectingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rUri, client, token, eventBus]);

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
    connectingRef.current = false; // Reset connecting flag
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
  }, [autoConnect, client]); // Only reconnect when client availability or autoConnect changes

  return {
    status,
    lastEvent,
    eventCount,
    connect,
    disconnect,
    isConnected: status === 'connected',
  };
}