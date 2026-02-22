/**
 * SSE Stream Factory
 *
 * Creates Server-Sent Events streams using native fetch() and manual parsing.
 * Does NOT use the EventSource API for better control over connection lifecycle.
 *
 * Supports EventBus integration for event-driven architecture.
 */

import type { SSEStream } from './types';
import type { Logger } from '../logger';
import type { EventBus, EventName } from '@semiont/core';

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
  /** If true, use custom event handlers instead of standard mapping */
  customEventHandler?: boolean;
  /** Optional EventBus for event-driven architecture */
  eventBus?: EventBus;
  /** Event prefix for EventBus (e.g., 'detection' → 'detection:progress') */
  eventPrefix?: string;
}

/**
 * Create an SSE stream with EventBus integration
 *
 * Uses native fetch() with manual SSE parsing for fine-grained control.
 * Supports AbortController for cancellation.
 * Events automatically emit to EventBus when provided in config.
 *
 * @param url - Full URL to SSE endpoint
 * @param fetchOptions - fetch() options (method, headers, body)
 * @param config - Event mapping configuration (must include eventBus and eventPrefix)
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
 *   'http://localhost:4000/resources/123/detect-annotations-stream',
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
  const customHandlers = new Map<string, (data?: any) => void>();
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

        buffer += decoder.decode(value, { stream: true });
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

      // Custom event handler (for resourceEvents which handles all events)
      if (config.customEventHandler) {
        const handler = customHandlers.get(eventType);
        if (handler) {
          handler(parsed);
          return;
        }
      }

      // EventBus integration (required - all streams must provide EventBus)
      if (config.eventBus && config.eventPrefix) {
        // Progress events (supports wildcard '*' for all events)
        if (config.progressEvents.includes('*' as any) || config.progressEvents.includes(eventType as any)) {
          config.eventBus.get(`${config.eventPrefix}:progress` as any).next(parsed);
        }

        // Complete event
        if (config.completeEvent && eventType === config.completeEvent) {
          config.eventBus.get(`${config.eventPrefix}:complete` as any).next(parsed);
          closed = true;
          abortController.abort();
        }

        // Error event
        if (config.errorEvent && eventType === config.errorEvent) {
          config.eventBus.get(`${config.eventPrefix}:failed` as any).next({ error: new Error(parsed.message || 'Stream error') });
          closed = true;
          abortController.abort();
        }
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
    },

    // Internal method for custom event handlers (used by resourceEvents)
    // Accepts domain event names (e.g., 'annotation.added', 'job.completed')
    // which are NOT in the Event Map (Event Map contains app-level events)
    on(event: string, callback: (data?: any) => void) {
      customHandlers.set(event, callback);
    }
  } as SSEStream & { on?: (event: string, callback: (data?: any) => void) => void };
}
