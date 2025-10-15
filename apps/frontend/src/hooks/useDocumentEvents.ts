'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { env } from '@/lib/env';
import { useSession } from 'next-auth/react';
import { fetchEventSource } from '@microsoft/fetch-event-source';

/**
 * Document event structure from the event store
 */
export interface DocumentEvent {
  id: string;
  type: string;
  timestamp: string;
  userId: string;
  documentId: string;
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

interface UseDocumentEventsOptions {
  documentId: string;
  onEvent?: (event: DocumentEvent) => void;
  onHighlightAdded?: (event: DocumentEvent) => void;
  onHighlightRemoved?: (event: DocumentEvent) => void;
  onReferenceCreated?: (event: DocumentEvent) => void;
  onReferenceResolved?: (event: DocumentEvent) => void;
  onReferenceDeleted?: (event: DocumentEvent) => void;
  onEntityTagAdded?: (event: DocumentEvent) => void;
  onEntityTagRemoved?: (event: DocumentEvent) => void;
  onDocumentArchived?: (event: DocumentEvent) => void;
  onDocumentUnarchived?: (event: DocumentEvent) => void;
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
 * const { status, connect, disconnect } = useDocumentEvents({
 *   documentId: 'doc-123',
 *   onHighlightAdded: (event) => {
 *     console.log('New highlight:', event.payload);
 *     // Update UI to show new highlight
 *   },
 *   onReferenceCreated: (event) => {
 *     console.log('New reference:', event.payload);
 *     // Refresh references list
 *   }
 * });
 * ```
 */
export function useDocumentEvents({
  documentId,
  onEvent,
  onHighlightAdded,
  onHighlightRemoved,
  onReferenceCreated,
  onReferenceResolved,
  onReferenceDeleted,
  onEntityTagAdded,
  onEntityTagRemoved,
  onDocumentArchived,
  onDocumentUnarchived,
  onError,
  autoConnect = true,
}: UseDocumentEventsOptions) {
  const { data: session, status: sessionStatus } = useSession();
  const [status, setStatus] = useState<StreamStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<DocumentEvent | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const handleEvent = useCallback((event: DocumentEvent) => {
    setLastEvent(event);
    setEventCount(prev => prev + 1);

    // Call generic handler
    onEvent?.(event);

    // Call specific handlers
    switch (event.type) {
      case 'highlight.added':
        onHighlightAdded?.(event);
        break;
      case 'highlight.removed':
        onHighlightRemoved?.(event);
        break;
      case 'reference.created':
        onReferenceCreated?.(event);
        break;
      case 'reference.resolved':
        onReferenceResolved?.(event);
        break;
      case 'reference.deleted':
        onReferenceDeleted?.(event);
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
    onHighlightAdded,
    onHighlightRemoved,
    onReferenceCreated,
    onReferenceResolved,
    onReferenceDeleted,
    onEntityTagAdded,
    onEntityTagRemoved,
    onDocumentArchived,
    onDocumentUnarchived,
  ]);

  const connect = useCallback(async () => {
    // Close any existing connection
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Get auth token from session
    if (!session?.backendToken) {
      onError?.('Authentication required');
      setStatus('error');
      return;
    }

    setStatus('connecting');

    // Create new abort controller
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build SSE URL
    const apiUrl = env.NEXT_PUBLIC_API_URL;
    const url = `${apiUrl}/api/documents/${documentId}/events/stream`;

    try {
      await fetchEventSource(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${session.backendToken}`,
        },
        signal: abortController.signal,

        async onopen(response) {
          if (response.ok) {
            setStatus('connected');
            reconnectAttemptsRef.current = 0; // Reset reconnect counter
          } else {
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
            return;
          }

          // Handle document events
          try {
            const event = JSON.parse(msg.data) as DocumentEvent;
            handleEvent(event);
          } catch (error) {
            console.error('[DocumentEvents] Failed to parse event:', error, msg.data);
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
            console.error(`[DocumentEvents] Document ${documentId} not found (404). Stopping reconnection attempts.`);
            onError?.('Document not found');
            throw err;
          }

          // Exponential backoff for reconnection
          reconnectAttemptsRef.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000);

          console.log(`[DocumentEvents] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);

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
          console.error('[DocumentEvents] Failed to connect:', error);
          setStatus('error');
          onError?.('Failed to connect to event stream');
        }
      }
    }
  }, [documentId, handleEvent, onError, session]);

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
  }, [documentId]);

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