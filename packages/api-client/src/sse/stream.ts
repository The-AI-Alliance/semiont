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
  /**
   * Auto-reconnect on transient errors with exponential backoff. Used by
   * long-lived streams (events-stream, global events) where connection drops
   * are expected and recovery should be invisible to the caller.
   *
   * When true, the factory tracks the most recent SSE event id and on
   * reconnect sets it as the Last-Event-ID header so the server can replay
   * any events missed during the gap.
   *
   * Defaults to false (short-lived streams fail fast on error).
   */
  reconnect?: boolean;
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
 *   'http://localhost:4000/resources/123/annotate-references',
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
  let abortController = new AbortController();
  let closed = false; // Flag to stop processing events after close/complete/error

  // Last SSE event id seen on this stream. Sent as Last-Event-ID on reconnect
  // so the server can replay missed events. null until the first event arrives.
  let lastEventId: string | null = null;

  // Reconnection backoff (only used when config.reconnect is true). Resets to
  // INITIAL on each successful connection.
  const RECONNECT_INITIAL_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;
  let reconnectDelayMs = RECONNECT_INITIAL_MS;

  /**
   * Start (or restart) the SSE connection and parse the stream.
   *
   * On the initial connection, no Last-Event-ID is sent. On reconnection
   * (when config.reconnect is true and a previous connection has dropped),
   * the most recently seen lastEventId is sent so the server can replay
   * missed events.
   */
  const connect = async (): Promise<void> => {
    try {
      // Log stream request
      logger?.debug('SSE Stream Request', {
        type: 'sse_request',
        url,
        method: fetchOptions.method || 'GET',
        timestamp: Date.now()
      });

      // Build headers, optionally adding Last-Event-ID for reconnect replay.
      // The native EventSource browser API would do this automatically; we
      // use fetch() so we have to set it explicitly.
      const headers: Record<string, string> = {
        ...(fetchOptions.headers as Record<string, string> | undefined),
        'Accept': 'text/event-stream',
      };
      if (lastEventId !== null) {
        headers['Last-Event-ID'] = lastEventId;
      }

      const response = await fetch(url, {
        ...fetchOptions,
        signal: abortController.signal,
        headers,
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
  const handleEvent = (eventType: string, data: string, id: string) => {
    // Skip keep-alive comments
    if (data.startsWith(':')) {
      return;
    }

    // Track the most recent event id for Last-Event-ID replay on reconnect.
    // This applies whether or not config.reconnect is set — short-lived
    // streams just won't act on it.
    if (id) {
      lastEventId = id;
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

      // Auto-route domain events: Events with 'metadata' field are StoredEvents from event store
      // Emit to the typed event channel (e.g., 'mark:added')
      if (typeof parsed === 'object' && parsed !== null && 'metadata' in parsed) {
        config.eventBus.get(eventType as EventName).next(parsed);
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
      logger?.error('SSE Failed to parse event data', { error, eventType, data });
    }
  };

  /**
   * Run connect() with auto-reconnect when config.reconnect is enabled.
   *
   * Each failure increases the delay (capped at RECONNECT_MAX_MS). The loop
   * exits when `closed` is set (user called close() or completeEvent fired).
   * Server-ended streams and network errors both trigger reconnect; AbortError
   * does not.
   *
   * Note: this currently does not reset the backoff after a "long enough"
   * successful streaming period. In practice connect() blocks for the entire
   * lifetime of the connection, so we don't have a good signal for "this
   * connection has been healthy for a while" without instrumenting the
   * read loop. Acceptable limitation: a flapping server gets the full
   * exponential backoff, which is the right behavior anyway.
   *
   * For non-reconnecting streams (the default), this just calls connect()
   * once and returns whatever it returns — no retry, no backoff.
   */
  const runConnect = async (): Promise<void> => {
    if (!config.reconnect) {
      return connect();
    }

    while (!closed) {
      // Refresh the abort controller for each attempt — the previous one
      // may have been aborted by a network error or by a previous connect.
      abortController = new AbortController();
      try {
        await connect();
        if (closed) return;
        // connect() returned without error and we're not closed: the server
        // ended the stream cleanly (rare for long-lived streams). Treat as
        // a reconnectable disconnect.
        logger?.info('SSE Stream ended cleanly; reconnecting', { url });
      } catch (error) {
        if (closed) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        logger?.warn('SSE Stream errored; reconnecting', {
          url,
          error: error instanceof Error ? error.message : String(error),
          delayMs: reconnectDelayMs,
        });
      }

      // Wait with backoff before reconnecting, then double the delay
      // (capped) so subsequent failures back off further.
      await new Promise<void>((resolve) => setTimeout(resolve, reconnectDelayMs));
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
    }
  };

  // Start connection immediately
  void runConnect();

  // Return SSE stream controller
  return {
    close() {
      closed = true;
      abortController.abort();
    }
  };
}
