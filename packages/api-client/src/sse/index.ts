/**
 * SSE Client for Semiont Streaming Endpoints
 *
 * Provides type-safe methods for Server-Sent Events streaming.
 * Does NOT use ky - uses native fetch() for SSE support.
 */

import { createSSEStream } from './stream';
import type { SSEStream } from './types';
import type { ResourceId } from '@semiont/core';
import type { AccessToken, BaseUrl, Logger } from '@semiont/core';

/**
 * SSE meta event for stream connection lifecycle
 * Internal to SSE infrastructure, not part of core event protocol
 */
export const SSE_STREAM_CONNECTED = 'stream-connected' as const;
export type SSEStreamConnected = typeof SSE_STREAM_CONNECTED;

/**
 * SSE Client configuration
 */
export interface SSEClientConfig {
  baseUrl: BaseUrl;
  logger?: Logger;
}

/**
 * Options for SSE requests
 */
export interface SSERequestOptions {
  auth?: AccessToken;
  /** EventBus for event-driven architecture (required) */
  eventBus: import('@semiont/core').EventBus;
}

/**
 * SSE Client for real-time streaming operations
 *
 * Separate from the main HTTP client to clearly mark streaming endpoints.
 * Uses native fetch() instead of ky for SSE support.
 *
 * This client is stateless - auth tokens are passed per-request via options.
 *
 * @example
 * ```typescript
 * const sseClient = new SSEClient({
 *   baseUrl: 'http://localhost:4000'
 * });
 *
 * const stream = sseClient.markReferences(
 *   'http://localhost:4000/resources/doc-123',
 *   { entityTypes: ['Person', 'Organization'] },
 *   { auth: 'your-token' }
 * );
 *
 * stream.onProgress((p) => console.log(p.message));
 * stream.onComplete((r) => console.log(`Found ${r.foundCount} entities`));
 * stream.onError((e) => console.error('Detection failed:', e));
 * ```
 */
export class SSEClient {
  private baseUrl: BaseUrl;
  private logger?: Logger;

  constructor(config: SSEClientConfig) {
    // Remove trailing slash for consistent URL construction
    this.baseUrl = (config.baseUrl.endsWith('/') ? config.baseUrl.slice(0, -1) : config.baseUrl) as BaseUrl;
    this.logger = config.logger;
  }

  /**
   * Get common headers for SSE requests
   */
  private getHeaders(auth?: AccessToken): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (auth) {
      headers['Authorization'] = `Bearer ${auth}`;
    }

    return headers;
  }

  /**
   * Subscribe to resource events (long-lived stream)
   *
   * Opens a long-lived SSE connection to receive real-time events for a resource.
   * Used for collaborative editing - see events from other users as they happen.
   *
   * This stream does NOT have a complete event - it stays open until explicitly closed.
   *
   * @param resourceId - Resource URI or ID to subscribe to
   * @param options - Request options (auth token)
   * @returns SSE stream controller with event callback
   *
   * @example
   * ```typescript
   * const stream = sseClient.resourceEvents(
   *   'http://localhost:4000/resources/doc-123',
   *   { auth: 'your-token' }
   * );
   *
   * stream.onProgress((event) => {
   *   console.log(`Event: ${event.type}`);
   *   console.log(`User: ${event.userId}`);
   *   console.log(`Sequence: ${event.metadata.sequenceNumber}`);
   *   console.log(`Payload:`, event.payload);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Stream error:', error.message);
   * });
   *
   * // Close when no longer needed (e.g., component unmount)
   * stream.close();
   * ```
   */
  resourceEvents(
    resourceId: ResourceId,
    options: SSERequestOptions & { onConnected?: () => void }
  ): SSEStream {
    const url = `${this.baseUrl}/resources/${resourceId}/events/stream`;

    // Events auto-route to EventBus:
    // - Domain events (mark:added, job:completed, etc.) emit to their typed channel
    // - stream-connected emits to 'stream-connected' channel (subscribers can handle or ignore)
    // No manual .on() registration needed - declarative auto-routing based on Event Map
    //
    // Long-lived stream: enable auto-reconnect with Last-Event-ID replay so a
    // network blip is invisible to the caller. The factory tracks the most
    // recent event id and sends it on each reconnect; the backend's
    // events-stream route honors Last-Event-ID and replays missed events
    // from the log up to its replay window cap.
    const stream = createSSEStream(
      url,
      {
        method: 'GET',
        headers: this.getHeaders(options.auth)
      },
      {
        progressEvents: ['*'], // Accept all event types (long-lived stream)
        completeEvent: null, // Never completes (long-lived)
        errorEvent: null, // No error event (errors throw)
        eventBus: options.eventBus,
        reconnect: true,
      },
      this.logger
    );

    if (options.onConnected) {
      const sub = options.eventBus.get(SSE_STREAM_CONNECTED).subscribe(() => {
        options.onConnected!();
        sub.unsubscribe(); // One-time callback
      });
    }

    return stream;
  }

  /**
   * Subscribe to global system events (long-lived stream)
   *
   * Opens a long-lived SSE connection to receive system-level domain events
   * (entity type additions, etc.) that are not scoped to a specific resource.
   *
   * @param options - Request options (auth token, eventBus)
   * @returns SSE stream controller
   *
   * @example
   * ```typescript
   * const stream = sseClient.globalEvents({ auth: 'your-token', eventBus });
   *
   * // Events auto-emit to EventBus typed channels — subscribe there
   * eventBus.get('mark:entity-type-added').subscribe((stored) => {
   *   // Invalidate entity types query
   * });
   *
   * // Close when no longer needed
   * stream.close();
   * ```
   */
  globalEvents(
    options: SSERequestOptions & { onConnected?: () => void }
  ): SSEStream {
    const url = `${this.baseUrl}/api/events/stream`;

    // Long-lived stream: enable auto-reconnect. The global-events-stream route
    // does not currently honor Last-Event-ID (its events are system-level and
    // typically don't have a sequenceNumber the way per-resource events do),
    // so reconnect here just re-establishes the connection without replay.
    // System events the client misses during the gap are not recovered —
    // consumers (frontend entity-types query) handle this with React Query
    // refetching on connect.
    const stream = createSSEStream(
      url,
      {
        method: 'GET',
        headers: this.getHeaders(options.auth)
      },
      {
        progressEvents: ['*'],
        completeEvent: null,
        errorEvent: null,
        eventBus: options.eventBus,
        reconnect: true,
      },
      this.logger
    );

    if (options.onConnected) {
      const sub = options.eventBus.get(SSE_STREAM_CONNECTED).subscribe(() => {
        options.onConnected!();
        sub.unsubscribe();
      });
    }

    return stream;
  }

  /**
   * Subscribe to participant attention stream (long-lived stream)
   *
   * Opens a participant-scoped SSE connection to receive cross-participant
   * beckon signals. Signals are delivered as 'beckon:focus' events routed
   * to the EventBus — the existing scroll/highlight machinery handles them.
   *
   * Signals are ephemeral — delivered if connected, dropped if not.
   *
   * @param options - Request options (auth token, eventBus)
   * @returns SSE stream controller
   */
  attentionStream(
    options: SSERequestOptions & { onConnected?: () => void }
  ): SSEStream {
    const url = `${this.baseUrl}/api/participants/me/attention-stream`;

    // Long-lived stream: enable auto-reconnect. Attention/presence events are
    // ephemeral by design — missed events are not replayed. The reconnect
    // here just re-establishes the connection so future events flow.
    const stream = createSSEStream(
      url,
      {
        method: 'GET',
        headers: this.getHeaders(options.auth)
      },
      {
        progressEvents: ['*'],
        completeEvent: null,
        errorEvent: null,
        eventBus: options.eventBus,
        reconnect: true,
      },
      this.logger
    );

    if (options.onConnected) {
      const sub = options.eventBus.get(SSE_STREAM_CONNECTED).subscribe(() => {
        options.onConnected!();
        sub.unsubscribe();
      });
    }

    return stream;
  }
}
