'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { ResourceId } from '@semiont/core';
import { accessToken } from '@semiont/core';
import type { ResourceEvent, StoredEvent, ResourceEventType } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useEventBus } from '../contexts/EventBusContext';

/**
 * Stream connection status
 */
export type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface UseResourceEventsOptions {
  rUri: ResourceId;
  onEvent?: (event: ResourceEvent) => void;
  onAnnotationAdded?: (event: Extract<ResourceEvent, { type: 'mark:added' }>) => void;
  onAnnotationRemoved?: (event: Extract<ResourceEvent, { type: 'mark:removed' }>) => void;
  onAnnotationBodyUpdated?: (event: Extract<ResourceEvent, { type: 'mark:body-updated' }>) => void;
  onEntityTagAdded?: (event: Extract<ResourceEvent, { type: 'mark:entity-tag-added' }>) => void;
  onEntityTagRemoved?: (event: Extract<ResourceEvent, { type: 'mark:entity-tag-removed' }>) => void;
  onDocumentArchived?: (event: Extract<ResourceEvent, { type: 'mark:archived' }>) => void;
  onDocumentUnarchived?: (event: Extract<ResourceEvent, { type: 'mark:unarchived' }>) => void;
  onError?: (error: string) => void;
  autoConnect?: boolean; // Default: true
}

/**
 * React hook for subscribing to real-time document events via SSE
 *
 * Opens a long-lived SSE connection to receive events as they happen.
 *
 * @example
 * ```tsx
 * const { status, connect, disconnect } = useResourceEvents({
 *   rUri: resourceUri('http://localhost:4000/resources/doc-123'),
 *   onAnnotationAdded: (event) => {
 *     console.log('New annotation:', event.payload);
 *   },
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
  const tokenRef = useRef(token);

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
    tokenRef.current = token;
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

    onEventRef.current?.(event);

    switch (event.type) {
      case 'mark:added':
        onAnnotationAddedRef.current?.(event);
        break;
      case 'mark:removed':
        onAnnotationRemovedRef.current?.(event);
        break;
      case 'mark:body-updated':
        onAnnotationBodyUpdatedRef.current?.(event);
        break;
      case 'mark:entity-tag-added':
        onEntityTagAddedRef.current?.(event);
        break;
      case 'mark:entity-tag-removed':
        onEntityTagRemovedRef.current?.(event);
        break;
      case 'mark:archived':
        onDocumentArchivedRef.current?.(event);
        break;
      case 'mark:unarchived':
        onDocumentUnarchivedRef.current?.(event);
        break;
    }
  }, []); // Empty deps - stable reference prevents reconnection!

  // Subscribe to each domain event type (StoredEvent wraps ResourceEvent)
  useEffect(() => {
    const eventTypes: ResourceEventType[] = [
      'mark:added', 'mark:removed', 'mark:body-updated',
      'mark:archived', 'mark:unarchived',
      'mark:entity-tag-added', 'mark:entity-tag-removed',
    ];
    const subs = eventTypes.map(type =>
      eventBus.get(type as any).subscribe((stored: StoredEvent) => {
        const { metadata, signature, ...event } = stored;
        handleEvent(event as ResourceEvent);
      })
    );
    return () => subs.forEach(s => s.unsubscribe());
  }, [eventBus, handleEvent]);

  const subRef = useRef<{ unsubscribe: () => void } | null>(null);

  const connect = useCallback(() => {
    if (subRef.current) return;
    setStatus('connecting');
    try {
      const sub = client.flows.resourceEvents(rUri, () =>
        tokenRef.current ? accessToken(tokenRef.current) : undefined
      );
      subRef.current = sub;
      setStatus('connected');
    } catch (error) {
      console.error('[ResourceEvents] Failed to connect:', error);
      setStatus('error');
      onErrorRef.current?.('Failed to connect to event stream');
    }
  }, [rUri, client]);

  const disconnect = useCallback(() => {
    if (subRef.current) {
      subRef.current.unsubscribe();
      subRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, rUri, client]);

  return {
    status,
    lastEvent,
    eventCount,
    connect,
    disconnect,
    isConnected: status === 'connected',
  };
}
