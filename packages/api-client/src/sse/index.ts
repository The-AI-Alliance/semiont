/**
 * SSE Client for Semiont Streaming Endpoints
 *
 * Provides type-safe methods for Server-Sent Events streaming.
 * Does NOT use ky - uses native fetch() for SSE support.
 */

import { createSSEStream } from './stream';
import type { SSEStream } from './types';
import type { ResourceUri, AnnotationUri } from '@semiont/core';
import type { AccessToken, BaseUrl, EntityType } from '@semiont/core';
import type { components } from '@semiont/core';
import type { Logger } from '../logger';

/**
 * Request body for reference detection stream
 */
export interface DetectReferencesStreamRequest {
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;
}

/**
 * Request body for generation stream
 * Uses generated type from OpenAPI schema
 */
export type GenerateResourceStreamRequest = components['schemas']['GenerateResourceStreamRequest'];

/**
 * Request body for highlight detection stream
 */
export interface DetectHighlightsStreamRequest {
  instructions?: string;
  /** Desired number of highlights per 2000 words (1-15) */
  density?: number;
}

/**
 * Request body for assessment detection stream
 */
export interface DetectAssessmentsStreamRequest {
  instructions?: string;
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';
  /** Desired number of assessments per 2000 words (1-10) */
  density?: number;
}

/**
 * Request body for comment detection stream
 */
export interface DetectCommentsStreamRequest {
  instructions?: string;
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  /** Desired number of comments per 2000 words (2-12) */
  density?: number;
}

/**
 * Request body for tag detection stream
 */
export interface DetectTagsStreamRequest {
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
 * const stream = sseClient.detectReferences(
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
   * const stream = sseClient.detectReferences(
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
  detectReferences(
    resourceId: ResourceUri,
    request: DetectReferencesStreamRequest,
    options?: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-annotations-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options?.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['reference-detection-started', 'reference-detection-progress'],
        completeEvent: 'reference-detection-complete',
        errorEvent: 'reference-detection-error',
        eventBus: options?.eventBus,
        eventPrefix: 'detection'
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
   * const stream = sseClient.generateResourceFromAnnotation(
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
   *   console.log(`Generated resource: ${result.resourceId}`);
   * });
   *
   * stream.onError((error) => {
   *   console.error('Generation failed:', error.message);
   * });
   *
   * // Cleanup when done
   * stream.close();
   * ```
   */
  generateResourceFromAnnotation(
    resourceId: ResourceUri,
    annotationId: AnnotationUri,
    request: GenerateResourceStreamRequest,
    options?: SSERequestOptions
  ): SSEStream {
    const resId = this.extractId(resourceId);
    const annId = this.extractId(annotationId);
    const url = `${this.baseUrl}/resources/${resId}/annotations/${annId}/generate-resource-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options?.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['generation-started', 'generation-progress'],
        completeEvent: 'generation-complete',
        errorEvent: 'generation-error',
        eventBus: options?.eventBus,
        eventPrefix: 'generation'
      },
      this.logger
    );
  }

  /**
   * Detect highlights in a resource (streaming)
   *
   * Streams highlight detection progress via Server-Sent Events.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (optional instructions)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.detectHighlights(
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
  detectHighlights(
    resourceId: ResourceUri,
    request: DetectHighlightsStreamRequest = {},
    options?: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-highlights-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options?.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['highlight-detection-started', 'highlight-detection-progress'],
        completeEvent: 'highlight-detection-complete',
        errorEvent: 'highlight-detection-error',
        eventBus: options?.eventBus,
        eventPrefix: 'detection'
      },
      this.logger
    );
  }

  /**
   * Detect assessments in a resource (streaming)
   *
   * Streams assessment detection progress via Server-Sent Events.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (optional instructions)
   * @param options - Request options (auth token)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.detectAssessments(
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
  detectAssessments(
    resourceId: ResourceUri,
    request: DetectAssessmentsStreamRequest = {},
    options?: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-assessments-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options?.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['assessment-detection-started', 'assessment-detection-progress'],
        completeEvent: 'assessment-detection-complete',
        errorEvent: 'assessment-detection-error',
        eventBus: options?.eventBus,
        eventPrefix: 'detection'
      },
      this.logger
    );
  }

  /**
   * Detect comments in a resource (streaming)
   *
   * Streams comment detection progress via Server-Sent Events.
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
   * const stream = sseClient.detectComments(
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
  detectComments(
    resourceId: ResourceUri,
    request: DetectCommentsStreamRequest = {},
    options?: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-comments-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options?.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['comment-detection-started', 'comment-detection-progress'],
        completeEvent: 'comment-detection-complete',
        errorEvent: 'comment-detection-error',
        eventBus: options?.eventBus,
        eventPrefix: 'detection'
      },
      this.logger
    );
  }

  /**
   * Detect tags in a resource (streaming)
   *
   * Streams tag detection progress via Server-Sent Events.
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
   * const stream = sseClient.detectTags(
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
  detectTags(
    resourceId: ResourceUri,
    request: DetectTagsStreamRequest,
    options?: SSERequestOptions
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-tags-stream`;

    return createSSEStream(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(options?.auth),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['tag-detection-started', 'tag-detection-progress'],
        completeEvent: 'tag-detection-complete',
        errorEvent: 'tag-detection-error',
        eventBus: options?.eventBus,
        eventPrefix: 'detection'
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
    options?: SSERequestOptions & { onConnected?: () => void }
  ): SSEStream {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/events/stream`;

    const stream = createSSEStream(
      url,
      {
        method: 'GET',
        headers: this.getHeaders(options?.auth)
      },
      {
        progressEvents: ['*'], // Accept all event types
        completeEvent: null, // Long-lived stream - no completion
        errorEvent: 'error', // Generic error event
        customEventHandler: true // Use custom event handling
      },
      this.logger
    ) as SSEStream & { on?: (event: string, callback: (data?: any) => void) => void };

    // Register handler for stream-connected meta-event so it is filtered out
    // of the progress stream and callers don't need to cast to any
    if (options?.onConnected) {
      stream.on?.('stream-connected', options.onConnected);
    } else {
      // Always consume stream-connected so it never reaches onProgress
      stream.on?.('stream-connected', () => {});
    }

    return stream;
  }
}
