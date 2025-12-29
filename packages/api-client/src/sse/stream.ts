/**
 * SSE Stream Factory
 *
 * Creates Server-Sent Events streams using native fetch() and manual parsing.
 * Does NOT use the EventSource API for better control over connection lifecycle.
 */

import type { SSEStream } from './types';
import type { Logger } from '../logger';

/**
 * Configuration for SSE stream event handling
 */
interface SSEConfig {
  /** Event types that trigger onProgress callback */
  progressEvents: string[];
  /** Event type that triggers onComplete callback (null for long-lived streams) */
  completeEvent: string | null;
  /** Event type that triggers onError callback */
  errorEvent: string | null;
  /** If true, use custom event handlers instead of standard mapping */
  customEventHandler?: boolean;
}

/**
 * Create an SSE stream with typed event callbacks
 *
 * Uses native fetch() with manual SSE parsing for fine-grained control.
 * Supports AbortController for cancellation.
 *
 * @typeParam TProgress - Type of progress event data
 * @typeParam TComplete - Type of completion event data
 *
 * @param url - Full URL to SSE endpoint
 * @param fetchOptions - fetch() options (method, headers, body)
 * @param config - Event mapping configuration
 * @returns SSEStream controller with callback registration and cleanup
 *
 * @example
 * ```typescript
 * const stream = createSSEStream<DetectionProgress, DetectionProgress>(
 *   'http://localhost:4000/resources/123/detect-annotations-stream',
 *   {
 *     method: 'POST',
 *     headers: { 'Authorization': 'Bearer token', 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ entityTypes: ['Person'] })
 *   },
 *   {
 *     progressEvents: ['detection-started', 'detection-progress'],
 *     completeEvent: 'detection-complete',
 *     errorEvent: 'detection-error'
 *   }
 * );
 *
 * stream.onProgress((p) => console.log(p.message));
 * stream.onComplete((r) => console.log('Done!'));
 * stream.close(); // Cleanup
 * ```
 */
export function createSSEStream<TProgress, TComplete>(
  url: string,
  fetchOptions: RequestInit,
  config: SSEConfig,
  logger?: Logger
): SSEStream<TProgress, TComplete> {
  const abortController = new AbortController();
  let progressCallback: ((data: TProgress) => void) | null = null;
  let completeCallback: ((data: TComplete) => void) | null = null;
  let errorCallback: ((error: Error) => void) | null = null;
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
        errorCallback?.(error);
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
        // Pass all events to progress handler if no specific handler
        progressCallback?.(parsed as TProgress);
        return;
      }

      // Progress events
      if (config.progressEvents.includes(eventType)) {
        progressCallback?.(parsed as TProgress);
      }

      // Complete event
      if (config.completeEvent && eventType === config.completeEvent) {
        completeCallback?.(parsed as TComplete);
        closed = true; // Stop processing further events
        abortController.abort(); // Close stream on completion
      }

      // Error event
      if (config.errorEvent && eventType === config.errorEvent) {
        errorCallback?.(new Error(parsed.message || 'Stream error'));
        closed = true; // Stop processing further events
        abortController.abort(); // Close stream on error
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
    onProgress(callback) {
      progressCallback = callback;
    },

    onComplete(callback) {
      completeCallback = callback;
    },

    onError(callback) {
      errorCallback = callback;
    },

    close() {
      abortController.abort();
    },

    // Internal method for custom event handlers (used by resourceEvents)
    on(event: string, callback: (data?: any) => void) {
      customHandlers.set(event, callback);
    }
  } as SSEStream<TProgress, TComplete> & { on?: (event: string, callback: (data?: any) => void) => void };
}
