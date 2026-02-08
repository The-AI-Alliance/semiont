/**
 * TypeScript types for Server-Sent Events (SSE) streaming
 *
 * These types match the event payloads sent by backend SSE endpoints.
 * They are not validated (per SSE-VALIDATION-CONSIDERATIONS.md) but provide
 * type safety for client code consuming the streams.
 */

/**
 * Progress event for entity detection stream
 *
 * Sent by POST /resources/:id/detect-annotations-stream
 *
 * @example
 * ```typescript
 * stream.onProgress((progress: DetectionProgress) => {
 *   if (progress.status === 'scanning') {
 *     console.log(`Scanning for ${progress.currentEntityType}...`);
 *     console.log(`Progress: ${progress.processedEntityTypes}/${progress.totalEntityTypes}`);
 *   }
 * });
 * ```
 */
export interface DetectionProgress {
  /** Current status of detection operation */
  status: 'started' | 'scanning' | 'complete' | 'error';
  /** Resource ID being scanned */
  resourceId: string;
  /** Currently scanning for this entity type (only present during 'scanning') */
  currentEntityType?: string;
  /** Total number of entity types to scan */
  totalEntityTypes: number;
  /** Number of entity types processed so far */
  processedEntityTypes: number;
  /** Human-readable status message */
  message?: string;
  /** Total entities found (only present in 'complete') */
  foundCount?: number;
}

/**
 * Progress event for resource generation stream
 *
 * Sent by POST /resources/:resourceId/annotations/:annotationId/generate-resource-stream
 *
 * @example
 * ```typescript
 * stream.onProgress((progress: GenerationProgress) => {
 *   console.log(`${progress.status}: ${progress.percentage}%`);
 *   console.log(progress.message);
 * });
 * ```
 */
export interface GenerationProgress {
  /** Current stage of generation operation */
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  /** Annotation ID being used as source */
  referenceId: string;
  /** Name of resource being generated */
  resourceName?: string;
  /** ID of generated resource (only present in 'complete') */
  resourceId?: string;
  /** ID of source resource */
  sourceResourceId?: string;
  /** Percentage complete (0-100) */
  percentage: number;
  /** Human-readable status message */
  message?: string;
}

/**
 * Progress event for highlight detection stream
 *
 * Sent by POST /resources/:id/detect-highlights-stream
 *
 * @example
 * ```typescript
 * stream.onProgress((progress: HighlightDetectionProgress) => {
 *   if (progress.status === 'analyzing') {
 *     console.log(`Analyzing: ${progress.percentage}%`);
 *   }
 * });
 * ```
 */
export interface HighlightDetectionProgress {
  /** Current status of highlight detection operation */
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  /** Resource ID being analyzed */
  resourceId: string;
  /** Current stage of processing */
  stage?: 'analyzing' | 'creating';
  /** Percentage complete (0-100) */
  percentage?: number;
  /** Human-readable status message */
  message?: string;
  /** Total highlights found */
  foundCount?: number;
  /** Total highlights created */
  createdCount?: number;
}

/**
 * Progress event for assessment detection stream
 *
 * Sent by POST /resources/:id/detect-assessments-stream
 *
 * @example
 * ```typescript
 * stream.onProgress((progress: AssessmentDetectionProgress) => {
 *   if (progress.status === 'analyzing') {
 *     console.log(`Analyzing: ${progress.percentage}%`);
 *   }
 * });
 * ```
 */
export interface AssessmentDetectionProgress {
  /** Current status of assessment detection operation */
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  /** Resource ID being analyzed */
  resourceId: string;
  /** Current stage of processing */
  stage?: 'analyzing' | 'creating';
  /** Percentage complete (0-100) */
  percentage?: number;
  /** Human-readable status message */
  message?: string;
  /** Total assessments found */
  foundCount?: number;
  /** Total assessments created */
  createdCount?: number;
}

/**
 * Progress event for comment detection stream
 *
 * Sent by POST /resources/:id/detect-comments-stream
 *
 * @example
 * ```typescript
 * stream.onProgress((progress: CommentDetectionProgress) => {
 *   if (progress.status === 'analyzing') {
 *     console.log(`Analyzing: ${progress.percentage}%`);
 *   }
 * });
 * ```
 */
export interface CommentDetectionProgress {
  /** Current status of comment detection operation */
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  /** Resource ID being analyzed */
  resourceId: string;
  /** Current stage of processing */
  stage?: 'analyzing' | 'creating';
  /** Percentage complete (0-100) */
  percentage?: number;
  /** Human-readable status message */
  message?: string;
  /** Total comments found */
  foundCount?: number;
  /** Total comments created */
  createdCount?: number;
}

/**
 * Progress event for tag detection stream
 *
 * Sent by POST /resources/:id/detect-tags-stream
 *
 * @example
 * ```typescript
 * stream.onProgress((progress: TagDetectionProgress) => {
 *   if (progress.status === 'analyzing') {
 *     console.log(`Analyzing ${progress.currentCategory}: ${progress.percentage}%`);
 *   }
 * });
 * ```
 */
export interface TagDetectionProgress {
  /** Current status of tag detection operation */
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  /** Resource ID being analyzed */
  resourceId: string;
  /** Current stage of processing */
  stage?: 'analyzing' | 'creating';
  /** Percentage complete (0-100) */
  percentage?: number;
  /** Currently processing this category */
  currentCategory?: string;
  /** Number of categories processed */
  processedCategories?: number;
  /** Total number of categories */
  totalCategories?: number;
  /** Human-readable status message */
  message?: string;
  /** Total tags found */
  tagsFound?: number;
  /** Total tags created */
  tagsCreated?: number;
  /** Tags found by category */
  byCategory?: Record<string, number>;
}

/**
 * Resource event from real-time event stream
 *
 * Sent by GET /resources/:id/events/stream
 *
 * This represents a single event from the event store, broadcast in real-time
 * as it occurs. Used for real-time collaboration - multiple users see each
 * other's changes as they happen.
 *
 * Re-exported from @semiont/core (authoritative source).
 * The discriminated union type provides type-safe event handling.
 *
 * @example
 * ```typescript
 * stream.onEvent((event: ResourceEvent) => {
 *   console.log(`Event: ${event.type}`);
 *   console.log(`User: ${event.userId}`);
 *   console.log(`Payload:`, event.payload);
 *   console.log(`Sequence: ${event.metadata.sequenceNumber}`);
 * });
 * ```
 */
export type { ResourceEvent } from '@semiont/core';

/**
 * SSE stream controller interface
 *
 * Returned by all SSE methods. Provides callback registration and cleanup.
 *
 * @typeParam TProgress - Type of progress events
 * @typeParam TComplete - Type of completion event
 *
 * @example
 * ```typescript
 * const stream: SSEStream<DetectionProgress, DetectionProgress> =
 *   client.sse.detectAnnotations(resourceId, { entityTypes: ['Person'] });
 *
 * stream.onProgress((p) => console.log(p.message));
 * stream.onComplete((r) => console.log(`Done! Found ${r.foundCount} entities`));
 * stream.onError((e) => console.error('Failed:', e.message));
 *
 * // Cleanup when done
 * stream.close();
 * ```
 */
export interface SSEStream<TProgress, TComplete> {
  /**
   * Register callback for progress events
   *
   * Called for each progress update (e.g., detection-started, detection-progress)
   */
  onProgress(callback: (progress: TProgress) => void): void;

  /**
   * Register callback for completion event
   *
   * Called once when operation completes successfully (e.g., detection-complete)
   */
  onComplete(callback: (result: TComplete) => void): void;

  /**
   * Register callback for error events
   *
   * Called if operation fails or stream encounters an error
   */
  onError(callback: (error: Error) => void): void;

  /**
   * Close the SSE stream and abort the connection
   *
   * Should be called to cleanup resources when stream is no longer needed.
   * Safe to call multiple times.
   *
   * @example
   * ```typescript
   * // React cleanup
   * useEffect(() => {
   *   const stream = client.sse.detectAnnotations(...);
   *   return () => stream.close();
   * }, []);
   * ```
   */
  close(): void;
}
