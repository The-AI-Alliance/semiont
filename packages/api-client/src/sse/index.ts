/**
 * SSE Client for Semiont Streaming Endpoints
 *
 * Provides type-safe methods for Server-Sent Events streaming.
 * Does NOT use ky - uses native fetch() for SSE support.
 */

import { createSSEStream } from './stream';
import type { SSEStream } from './types';
import type { ResourceUri, AnnotationUri } from '@semiont/core';
import type { AccessToken, BaseUrl, EntityType, Logger } from '@semiont/core';
import type { components } from '@semiont/core';

/**
 * SSE meta event for stream connection lifecycle
 * Internal to SSE infrastructure, not part of core event protocol
 */
export const SSE_STREAM_CONNECTED = 'stream-connected' as const;
export type SSEStreamConnected = typeof SSE_STREAM_CONNECTED;

/**
 * Request body for reference annotation stream
 */
export interface AnnotateReferencesStreamRequest {
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;
}

/**
 * Request body for generation stream
 * Uses generated type from OpenAPI schema
 */
export type YieldResourceStreamRequest = components['schemas']['YieldResourceStreamRequest'];

/**
 * Request body for highlight annotation stream
 */
export interface AnnotateHighlightsStreamRequest {
  instructions?: string;
  /** Desired number of highlights per 2000 words (1-15) */
  density?: number;
}

/**
 * Request body for assessment annotation stream
 */
export interface AnnotateAssessmentsStreamRequest {
  instructions?: string;
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';
  /** Desired number of assessments per 2000 words (1-10) */
  density?: number;
}

/**
 * Request body for comment annotation stream
 */
export interface AnnotateCommentsStreamRequest {
  instructions?: string;
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  /** Desired number of comments per 2000 words (2-12) */
  density?: number;
}

/**
 * Request body for tag annotation stream
 */
export interface AnnotateTagsStreamRequest {
  schemaId: string;
  categories: string[];
}

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
 * const stream = sseClient.annotateReferences(
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
   * Extract resource ID from URI
   *
   * Handles both full URIs and plain IDs:
   * - 'http://localhost:4000/resources/doc-123' -> 'doc-123'
   * - 'doc-123' -> 'doc-123'
   */
  private extractId(uri: string): string {
    const parts = uri.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Detect annotations in a resource (streaming)
   *
   * Streams entity detection progress via Server-Sent Events.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (entity types to detect)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.annotateReferences(
   *   'http://localhost:4000/resources/doc-123',
   *   { entityTypes: ['Person', 'Organization'] },
   *   { auth: 'your-token' }
   * );
   *
   * stream.onProgress((progress) => {
   *   console.log(`Scanning: ${progress.currentEntityType}`);
   *   console.log(`Progress: ${progress.processedEntityTypes}/${progress.totalEntityTypes}`);
   * });
   *
   * stream.onComplete((result) => {
   *   console.log(`Detection complete! Found ${result.foundCount} entities`);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Detection failed:', error.message);
   * });
   *
   * // Cleanup when done
   * stream.close();
   * ```
   */
  annotateReferences(
    resourceId: ResourceUri,
    request: AnnotateReferencesStreamRequest,
    options: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/annotate-references-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['annotate:progress'],
        completeEvent: 'annotate:assist-finished',
        errorEvent: 'annotate:assist-failed',
        eventBus: options.eventBus,
        eventPrefix: undefined
      },
      this.logger
    );
  }

  /**
   * Generate resource from annotation (streaming)
   *
   * Streams resource generation progress via Server-Sent Events.
   *
   * @param resourceId - Source resource URI or ID
   * @param annotationId - Annotation URI or ID to use as generation source
   * @param request - Generation options (title, prompt, language)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.yieldResourceFromAnnotation(
   *   'http://localhost:4000/resources/doc-123',
   *   'http://localhost:4000/annotations/ann-456',
   *   { language: 'es', title: 'Spanish Summary' },
   *   { auth: 'your-token' }
   * );
   *
   * stream.onProgress((progress) => {
   *   console.log(`${progress.status}: ${progress.percentage}%`);
   *   console.log(progress.message);
   * });
   *
   * stream.onComplete((result) => {
   *   console.log(`Yielded resource: ${result.resourceId}`);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Yield failed:', error.message);
   * });
   *
   * // Cleanup when done
   * stream.close();
   * ```
   */
  yieldResourceFromAnnotation(
    resourceId: ResourceUri,
    annotationId: AnnotationUri,
    request: YieldResourceStreamRequest,
    options: SSERequestOptions
  ): SSEStream {
    const resId = this.extractId(resourceId);
    const annId = this.extractId(annotationId);
    const url = `${this.baseUrl}/resources/${resId}/annotations/${annId}/yield-resource-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['yield:progress'],
        completeEvent: 'yield:finished',
        errorEvent: 'yield:failed',
        eventBus: options.eventBus,
        eventPrefix: undefined
      },
      this.logger
    );
  }

  /**
   * Detect highlights in a resource (streaming)
   *
   * Streams highlight annotation progress via Server-Sent Events.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (optional instructions)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.annotateHighlights(
   *   'http://localhost:4000/resources/doc-123',
   *   { instructions: 'Focus on key technical points' },
   *   { auth: 'your-token' }
   * );
   *
   * stream.onProgress((progress) => {
   *   console.log(`${progress.status}: ${progress.percentage}%`);
   *   console.log(progress.message);
   * });
   *
   * stream.onComplete((result) => {
   *   console.log(`Detection complete! Created ${result.createdCount} highlights`);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Detection failed:', error.message);
   * });
   *
   * // Cleanup when done
   * stream.close();
   * ```
   */
  annotateHighlights(
    resourceId: ResourceUri,
    request: AnnotateHighlightsStreamRequest = {},
    options: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/annotate-highlights-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['annotate:progress'],
        completeEvent: 'annotate:assist-finished',
        errorEvent: 'annotate:assist-failed',
        eventBus: options.eventBus,
        eventPrefix: undefined
      },
      this.logger
    );
  }

  /**
   * Detect assessments in a resource (streaming)
   *
   * Streams assessment annotation progress via Server-Sent Events.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (optional instructions)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.annotateAssessments(
   *   'http://localhost:4000/resources/doc-123',
   *   { instructions: 'Evaluate claims for accuracy' },
   *   { auth: 'your-token' }
   * );
   *
   * stream.onProgress((progress) => {
   *   console.log(`${progress.status}: ${progress.percentage}%`);
   *   console.log(progress.message);
   * });
   *
   * stream.onComplete((result) => {
   *   console.log(`Detection complete! Created ${result.createdCount} assessments`);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Detection failed:', error.message);
   * });
   *
   * // Cleanup when done
   * stream.close();
   * ```
   */
  annotateAssessments(
    resourceId: ResourceUri,
    request: AnnotateAssessmentsStreamRequest = {},
    options: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/annotate-assessments-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['annotate:progress'],
        completeEvent: 'annotate:assist-finished',
        errorEvent: 'annotate:assist-failed',
        eventBus: options.eventBus,
        eventPrefix: undefined
      },
      this.logger
    );
  }

  /**
   * Detect comments in a resource (streaming)
   *
   * Streams comment annotation progress via Server-Sent Events.
   * Uses AI to identify passages that would benefit from explanatory comments
   * and creates comment annotations with contextual information.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (optional instructions and tone)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.annotateComments(
   *   'http://localhost:4000/resources/doc-123',
   *   {
   *     instructions: 'Focus on technical terminology',
   *     tone: 'scholarly'
   *   },
   *   { auth: 'your-token' }
   * );
   *
   * stream.onProgress((progress) => {
   *   console.log(`${progress.status}: ${progress.percentage}%`);
   * });
   *
   * stream.onComplete((result) => {
   *   console.log(`Detection complete! Created ${result.createdCount} comments`);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Detection failed:', error.message);
   * });
   *
   * // Cleanup when done
   * stream.close();
   * ```
   */
  annotateComments(
    resourceId: ResourceUri,
    request: AnnotateCommentsStreamRequest = {},
    options: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/annotate-comments-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['annotate:progress'],
        completeEvent: 'annotate:assist-finished',
        errorEvent: 'annotate:assist-failed',
        eventBus: options.eventBus,
        eventPrefix: undefined
      },
      this.logger
    );
  }

  /**
   * Detect tags in a resource (streaming)
   *
   * Streams tag annotation progress via Server-Sent Events.
   * Uses AI to identify passages serving specific structural roles
   * (e.g., IRAC, IMRAD, Toulmin) and creates tag annotations with dual-body structure.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (schema and categories to detect)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.annotateTags(
   *   'http://localhost:4000/resources/doc-123',
   *   {
   *     schemaId: 'legal-irac',
   *     categories: ['Issue', 'Rule', 'Application', 'Conclusion']
   *   },
   *   { auth: 'your-token' }
   * );
   *
   * stream.onProgress((progress) => {
   *   console.log(`${progress.status}: ${progress.percentage}%`);
   *   console.log(`Processing ${progress.currentCategory}...`);
   * });
   *
   * stream.onComplete((result) => {
   *   console.log(`Detection complete! Created ${result.tagsCreated} tags`);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Detection failed:', error.message);
   * });
   *
   * // Cleanup when done
   * stream.close();
   * ```
   */
  annotateTags(
    resourceId: ResourceUri,
    request: AnnotateTagsStreamRequest,
    options: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/annotate-tags-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['annotate:progress'],
        completeEvent: 'annotate:assist-finished',
        errorEvent: 'annotate:assist-failed',
        eventBus: options.eventBus,
        eventPrefix: undefined
      },
      this.logger
    );
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
    resourceId: ResourceUri,
    options: SSERequestOptions & { onConnected?: () => void }
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/events/stream`;

    // Events auto-route to EventBus:
    // - Domain events (annotation.added, job.completed, etc.) emit to both their specific channel and 'make-meaning:event'
    // - stream-connected emits to 'stream-connected' channel (subscribers can handle or ignore)
    // No manual .on() registration needed - declarative auto-routing based on Event Map
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
        eventBus: options.eventBus
      },
      this.logger
    );

    // Handle onConnected callback by subscribing to SSE stream-connected event
    // Note: Type assertion needed because SSE_STREAM_CONNECTED is SSE infrastructure, not part of EventMap
    if (options.onConnected) {
      const sub = options.eventBus.get(SSE_STREAM_CONNECTED as any).subscribe(() => {
        options.onConnected!();
        sub.unsubscribe(); // One-time callback
      });
    }

    return stream;
  }
}
