/**
 * SSE Stream Factory
 *
 * Creates Server-Sent Events streams using native fetch() and manual parsing.
 * Does NOT use the EventSource API for better control over connection lifecycle.
 *
 * Supports EventBus integration for event-driven architecture.
 */

import type { SSEStream } from './types';
import type { Logger, EventBus, EventName } from '@semiont/core';

/**
 * Configuration for SSE stream event handling
 */
interface SSEConfig {
  /**
   * Event types that trigger onProgress callback
   * For typed streams: Use EventName values from Event Map
   * For wildcard streams: Use ['*'] to accept all events
   */
  progressEvents: (EventName | '*')[];
  /** Event type that triggers onComplete callback (null for long-lived streams) */
  completeEvent: EventName | null;
  /**
   * Event type that triggers onError callback
   * For typed streams: Use EventName values from Event Map
   * For generic error handling: Use 'error'
   */
  errorEvent: EventName | 'error' | null;
  /** EventBus for event-driven architecture (required) */
  eventBus: EventBus;
  /** Event prefix for EventBus (e.g., 'detection' → 'detection:progress') */
  eventPrefix?: string;
}

/**
 * Create an SSE stream with EventBus integration
 *
 * Uses native fetch() with manual SSE parsing for fine-grained control.
 * Supports AbortController for cancellation.
 * All events automatically route to EventBus (required).
 *
 * @param url - Full URL to SSE endpoint
 * @param fetchOptions - fetch() options (method, headers, body)
 * @param config - Event mapping configuration (eventBus required, eventPrefix optional)
 * @returns SSEStream controller with close() method
 *
 * @example
 * ```typescript
 * const eventBus = new EventBus();
 *
 * // Subscribe to events
 * eventBus.get('detection:progress').subscribe((p) => console.log(p.message));
 * eventBus.get('detection:complete').subscribe(() => console.log('Done!'));
 *
 * // Start stream - events auto-emit
 * const stream = createSSEStream(
 *   'http://localhost:4000/resources/123/annotate-references-stream',
 *   {
 *     method: 'POST',
 *     headers: { 'Authorization': 'Bearer token', 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ entityTypes: ['Person'] })
 *   },
 *   {
 *     progressEvents: ['detection-started', 'detection-progress'],
 *     completeEvent: 'detection-complete',
 *     errorEvent: 'detection-error',
 *     eventBus,
 *     eventPrefix: 'detection'
 *   }
 * );
 *
 * stream.close(); // Cleanup
 * ```
 */
export function createSSEStream(
  url: string,
  fetchOptions: RequestInit,
  config: SSEConfig,
  logger?: Logger
): SSEStream {
  const abortController = new AbortController();
  let closed = false; // Flag to stop processing events after close/complete/error

  /**
   * Start the SSE connection and parse the stream
   */
  const connect = async () => {
    try {
      // Log stream request
      logger?.debug('SSE Stream Request', {
        type: 'sse_request',
        url,
        method: fetchOptions.method || 'GET',
        timestamp: Date.now()
      });

      const response = await fetch(url, {
        ...fetchOptions,
        signal: abortController.signal,
        headers: {
          ...fetchOptions.headers,
          'Accept': 'text/event-stream'
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { message?: string };
        const error = new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);

        // Log connection error
        logger?.error('SSE Stream Error', {
          type: 'sse_error',
          url,
          error: error.message,
          status: response.status,
          phase: 'connect'
        });

        throw error;
      }

      if (!response.body) {
        const error = new Error('Response body is null - server did not return a stream');

        logger?.error('SSE Stream Error', {
          type: 'sse_error',
          url,
          error: error.message,
          phase: 'connect'
        });

        throw error;
      }

      // Log successful connection
      logger?.info('SSE Stream Connected', {
        type: 'sse_connected',
        url,
        status: response.status,
        contentType: response.headers.get('content-type') || 'unknown'
      });

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Event state persists across reads to handle multi-chunk events
      let eventType = '';
      let eventData = '';
      let eventId = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done || closed) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');

        // Keep the last partial line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            eventData = line.slice(5).trim();
          } else if (line.startsWith('id:')) {
            eventId = line.slice(3).trim();
          } else if (line === '') {
            // Empty line marks end of event
            if (eventData && !closed) {
              handleEvent(eventType, eventData, eventId);
              if (closed) break; // Stop processing if event triggered close
              eventType = '';
              eventData = '';
              eventId = '';
            }
          }
        }

        if (closed) break; // Exit outer loop if closed
      }

      // Log stream close
      logger?.info('SSE Stream Closed', {
        type: 'sse_closed',
        url,
        reason: 'complete'
      });
    } catch (error) {
      // Don't report AbortError (normal cleanup)
      if (error instanceof Error && error.name !== 'AbortError') {
        logger?.error('SSE Stream Error', {
          type: 'sse_error',
          url,
          error: error.message,
          phase: 'stream'
        });
      } else if (error instanceof Error && error.name === 'AbortError') {
        // Log normal close (abort)
        logger?.info('SSE Stream Closed', {
          type: 'sse_closed',
          url,
          reason: 'abort'
        });
      }
    }
  };

  /**
   * Handle a parsed SSE event
   */
  const handleEvent = (eventType: string, data: string, _id: string) => {
    // Skip keep-alive comments
    if (data.startsWith(':')) {
      return;
    }

    try {
      const parsed = JSON.parse(data);

      // Log SSE event (debug level - can be verbose)
      logger?.debug('SSE Event Received', {
        type: 'sse_event',
        url,
        event: eventType || 'message',
        hasData: !!data
      });

      // Auto-route domain events: Events with 'type' field are domain events from event store
      // Emit them directly to both their specific event name AND to 'make-meaning:event'
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
        // Emit to specific domain event channel (e.g., 'annotation.added')
        config.eventBus.get(eventType as EventName).next(parsed);
        // Also emit to generic domain event channel for broad subscribers
        config.eventBus.get('make-meaning:event').next(parsed);
        return; // Domain events don't need prefix mapping
      }

      // Non-domain event (progress, complete, error) - emit to specific channel
      config.eventBus.get(eventType as EventName).next(parsed);

      // Handle stream lifecycle based on event type
      if (config.completeEvent && eventType === config.completeEvent) {
        closed = true;
        abortController.abort();
      } else if (config.errorEvent && eventType === config.errorEvent) {
        closed = true;
        abortController.abort();
      }
    } catch (error) {
      console.error('[SSE] Failed to parse event data:', error);
      console.error('[SSE] Event type:', eventType);
      console.error('[SSE] Data:', data);
    }
  };

  // Start connection immediately
  connect();

  // Return SSE stream controller
  return {
    close() {
      abortController.abort();
    }
  };
}
