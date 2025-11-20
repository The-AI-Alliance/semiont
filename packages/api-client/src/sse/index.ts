/**
 * SSE Client for Semiont Streaming Endpoints
 *
 * Provides type-safe methods for Server-Sent Events streaming.
 * Does NOT use ky - uses native fetch() for SSE support.
 */

import { createSSEStream } from './stream';
import type {
  DetectionProgress,
  GenerationProgress,
  HighlightDetectionProgress,
  AssessmentDetectionProgress,
  ResourceEvent,
  SSEStream
} from './types';
import type { ResourceUri, AnnotationUri } from '../branded-types';
import type { AccessToken, BaseUrl, EntityType } from '../branded-types';

/**
 * Request body for detection stream
 */
export interface DetectAnnotationsStreamRequest {
  entityTypes: EntityType[];
}

/**
 * Request body for generation stream
 */
export interface GenerateResourceStreamRequest {
  title?: string;
  prompt?: string;
  language?: string;
}

/**
 * Request body for highlight detection stream
 */
export interface DetectHighlightsStreamRequest {
  instructions?: string;
}

/**
 * Request body for assessment detection stream
 */
export interface DetectAssessmentsStreamRequest {
  instructions?: string;
}

/**
 * SSE Client configuration
 */
export interface SSEClientConfig {
  baseUrl: BaseUrl;
  accessToken?: AccessToken;
}

/**
 * SSE Client for real-time streaming operations
 *
 * Separate from the main HTTP client to clearly mark streaming endpoints.
 * Uses native fetch() instead of ky for SSE support.
 *
 * @example
 * ```typescript
 * const sseClient = new SSEClient({
 *   baseUrl: 'http://localhost:4000',
 *   accessToken: 'your-token'
 * });
 *
 * const stream = sseClient.detectAnnotations(
 *   'http://localhost:4000/resources/doc-123',
 *   { entityTypes: ['Person', 'Organization'] }
 * );
 *
 * stream.onProgress((p) => console.log(p.message));
 * stream.onComplete((r) => console.log(`Found ${r.foundCount} entities`));
 * stream.onError((e) => console.error('Detection failed:', e));
 * ```
 */
export class SSEClient {
  private baseUrl: BaseUrl;
  private accessToken: AccessToken | null = null;

  constructor(config: SSEClientConfig) {
    // Remove trailing slash for consistent URL construction
    this.baseUrl = (config.baseUrl.endsWith('/') ? config.baseUrl.slice(0, -1) : config.baseUrl) as BaseUrl;
    this.accessToken = config.accessToken || null;
  }

  /**
   * Set the access token for authenticated requests
   */
  setAccessToken(token: AccessToken): void {
    this.accessToken = token;
  }

  /**
   * Clear the access token
   */
  clearAccessToken(): void {
    this.accessToken = null;
  }

  /**
   * Get common headers for SSE requests
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
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
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.detectAnnotations(
   *   'http://localhost:4000/resources/doc-123',
   *   { entityTypes: ['Person', 'Organization'] }
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
  detectAnnotations(
    resourceId: ResourceUri,
    request: DetectAnnotationsStreamRequest
  ): SSEStream<DetectionProgress, DetectionProgress> {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-annotations-stream`;

    return createSSEStream<DetectionProgress, DetectionProgress>(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['detection-started', 'detection-progress'],
        completeEvent: 'detection-complete',
        errorEvent: 'detection-error'
      }
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
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.generateResourceFromAnnotation(
   *   'http://localhost:4000/resources/doc-123',
   *   'http://localhost:4000/annotations/ann-456',
   *   { language: 'es', title: 'Spanish Summary' }
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
    request: GenerateResourceStreamRequest = {}
  ): SSEStream<GenerationProgress, GenerationProgress> {
    const resId = this.extractId(resourceId);
    const annId = this.extractId(annotationId);
    const url = `${this.baseUrl}/resources/${resId}/annotations/${annId}/generate-resource-stream`;

    return createSSEStream<GenerationProgress, GenerationProgress>(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['generation-started', 'generation-progress'],
        completeEvent: 'generation-complete',
        errorEvent: 'generation-error'
      }
    );
  }

  /**
   * Detect highlights in a resource (streaming)
   *
   * Streams highlight detection progress via Server-Sent Events.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (optional instructions)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.detectHighlights(
   *   'http://localhost:4000/resources/doc-123',
   *   { instructions: 'Focus on key technical points' }
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
    request: DetectHighlightsStreamRequest = {}
  ): SSEStream<HighlightDetectionProgress, HighlightDetectionProgress> {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-highlights-stream`;

    return createSSEStream<HighlightDetectionProgress, HighlightDetectionProgress>(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['highlight-detection-started', 'highlight-detection-progress'],
        completeEvent: 'highlight-detection-complete',
        errorEvent: 'highlight-detection-error'
      }
    );
  }

  /**
   * Detect assessments in a resource (streaming)
   *
   * Streams assessment detection progress via Server-Sent Events.
   *
   * @param resourceId - Resource URI or ID
   * @param request - Detection configuration (optional instructions)
   * @returns SSE stream controller with progress/complete/error callbacks
   *
   * @example
   * ```typescript
   * const stream = sseClient.detectAssessments(
   *   'http://localhost:4000/resources/doc-123',
   *   { instructions: 'Evaluate claims for accuracy' }
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
    request: DetectAssessmentsStreamRequest = {}
  ): SSEStream<AssessmentDetectionProgress, AssessmentDetectionProgress> {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/detect-assessments-stream`;

    return createSSEStream<AssessmentDetectionProgress, AssessmentDetectionProgress>(
      url,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      },
      {
        progressEvents: ['assessment-detection-started', 'assessment-detection-progress'],
        completeEvent: 'assessment-detection-complete',
        errorEvent: 'assessment-detection-error'
      }
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
   * @returns SSE stream controller with event callback
   *
   * @example
   * ```typescript
   * const stream = sseClient.resourceEvents('http://localhost:4000/resources/doc-123');
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
  resourceEvents(resourceId: ResourceUri): SSEStream<ResourceEvent, never> {
    const id = this.extractId(resourceId);
    const url = `${this.baseUrl}/resources/${id}/events/stream`;

    return createSSEStream<ResourceEvent, never>(
      url,
      {
        method: 'GET',
        headers: this.getHeaders()
      },
      {
        progressEvents: ['*'], // Accept all event types
        completeEvent: null, // Long-lived stream - no completion
        errorEvent: 'error', // Generic error event
        customEventHandler: true // Use custom event handling
      }
    );
  }
}
