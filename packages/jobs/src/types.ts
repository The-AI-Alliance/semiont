/**
 * Job Queue Type Definitions - Discriminated Union Design
 *
 * Jobs represent async work that can be queued, processed, and monitored.
 * Uses TypeScript discriminated unions to enforce valid state transitions.
 *
 * Design principles:
 * - Each job status has specific valid fields
 * - Type narrowing works automatically via status discriminant
 * - No optional fields that may or may not exist
 * - State machine is explicit and type-safe
 */

import type { JobId, EntityType, ResourceId, UserId, GenerationJobParams, TagSchema, UnitCursor, components } from '@semiont/core';
import type { JobReferenceAnnotationResult, JobHighlightAnnotationResult, JobCommentAnnotationResult, JobAssessmentAnnotationResult, JobTagAnnotationResult } from '@semiont/core';

export type JobType = components['schemas']['JobType'];
export type JobStatus = components['schemas']['Job']['status'];

// ============================================================================
// Core Metadata and Parameters
// ============================================================================

/**
 * Job metadata - common to all states
 */
export interface JobMetadata {
  id: JobId;
  type: JobType;
  /**
   * Who requested the job: the verified DID the gateway stamped on the
   * `job:create`, and the ONLY identity a job carries. The dispatcher
   * records it as the requester on `job:assigned`, which is what lets a
   * write citing this job be attributed — so nothing else about the
   * requester needs to travel with the job, or be trusted from it.
   */
  userId: UserId;
  created: string;
  retryCount: number;
  maxRetries: number;
  /**
   * Checkpointed resume: the entity-type units whose annotations are fully
   * committed. Written by the dispatcher's queue from `job:checkpoint` (as
   * each unit lands) and from `job:fail`, unioned across attempts — and
   * because a retried record keeps its metadata, the checkpoint survives
   * every retry. A retried claim skips these units, so completed work is
   * neither redone nor duplicated.
   */
  completedUnits?: string[];
  /**
   * The finer grain `completedUnits` cannot express: how far each UNFINISHED
   * unit got, keyed by unit. Written per committed chunk, so a job that dies
   * mid-unit resumes there rather than at the top — which for a one-unit job
   * (every motivation job, and the 1958 document's single `Person` type) is
   * the difference between resuming and restarting.
   *
   * A unit here is in progress, never complete; the two sets are disjoint by
   * construction — the dispatcher's merge drops a completed unit's cursor.
   * Merged monotonically per unit (the furthest cursor wins), never unioned.
   */
  unitCursors?: Record<string, UnitCursor>;
}

/**
 * Locale conventions for detection/generation params.
 *
 * Two independent locales flow through these jobs:
 *
 *   - `language` — *annotation body* locale. The BCP-47 tag the LLM should
 *     write generated body text in (comment text, assessment text, generated
 *     resource content, tag category label). Sourced from the user's UI
 *     locale. Stamped onto the W3C `TextualBody.language` field.
 *
 *   - `sourceLanguage` — *source resource* locale. The BCP-47 tag of the
 *     content being analyzed. Sourced from `ResourceDescriptor` (carried as
 *     `Representation.language` on the primary representation). Used in
 *     prompts so the LLM analyzes non-English source correctly even when
 *     the user's UI locale differs.
 *
 * Examples: a German user analyzing an English document → `language='de'`,
 * `sourceLanguage='en'`. An English user detecting entities in a French
 * document → `language='en'` (unused for entity references), `sourceLanguage='fr'`.
 */

/**
 * Detection job parameters
 */
export type DetectionParams = {
  resourceId: ResourceId;
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
};


/**
 * Highlight detection job parameters
 */
export type HighlightDetectionParams = {
  resourceId: ResourceId;
  instructions?: string;
  density?: number;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
};

/**
 * Assessment detection job parameters
 */
export type AssessmentDetectionParams = {
  resourceId: ResourceId;
  instructions?: string;
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';
  density?: number;
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
};

/**
 * Comment detection job parameters
 */
export type CommentDetectionParams = {
  resourceId: ResourceId;
  instructions?: string;
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  density?: number;
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
};

/**
 * Tag detection job parameters.
 *
 * Carries the *full* `TagSchema` (not just an id). The dispatcher resolves
 * the caller-supplied `schemaId` against the per-KB tag-schema projection
 * at job-creation time and embeds the resolved schema here, keeping the
 * worker independent of the registry.
 */
export type TagDetectionParams = {
  resourceId: ResourceId;
  schema: TagSchema;
  categories: string[];
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
};

// ============================================================================
// Generic Job State Types
// ============================================================================

/**
 * The progress a running job carries: the last its worker reported with
 * `job:report-progress`, or an empty object before the first report. One shape
 * for every job type, as the spec states it (JobRunning).
 */
export type StoredProgress = components['schemas']['JobStoredProgress'];

/**
 * Pending job - just created, waiting to be picked up
 */
export interface PendingJob<P> {
  status: 'pending';
  metadata: JobMetadata;
  params: P;
}

/**
 * Running job - actively being processed
 */
export interface RunningJob<P> {
  status: 'running';
  metadata: JobMetadata;
  params: P;
  startedAt: string;
  progress: StoredProgress;
}

/**
 * Complete job - successfully finished
 */
export interface CompleteJob<P, R> {
  status: 'complete';
  metadata: JobMetadata;
  params: P;
  startedAt: string;
  completedAt: string;
  result: R;
}

/**
 * Failed job - encountered an error
 */
export interface FailedJob<P> {
  status: 'failed';
  metadata: JobMetadata;
  params: P;
  startedAt?: string;
  completedAt: string;
  error: string;
}

/**
 * Cancelled job - stopped by user
 */
export interface CancelledJob<P> {
  status: 'cancelled';
  metadata: JobMetadata;
  params: P;
  startedAt?: string;
  completedAt: string;
}

/**
 * Generic job - discriminated union of all states
 */
export type Job<P, R> =
  | PendingJob<P>
  | RunningJob<P>
  | CompleteJob<P, R>
  | FailedJob<P>
  | CancelledJob<P>;

// ============================================================================
// Concrete Job Types
// ============================================================================

export type DetectionJob = Job<DetectionParams, JobReferenceAnnotationResult>;
/** A generation job's params carry the resource the dispatcher derived from the context's focus. */
export type GenerationJob = Job<GenerationJobParams & { resourceId: ResourceId }, components['schemas']['JobGenerationResult']>;
export type HighlightDetectionJob = Job<HighlightDetectionParams, JobHighlightAnnotationResult>;
export type AssessmentDetectionJob = Job<AssessmentDetectionParams, JobAssessmentAnnotationResult>;
export type CommentDetectionJob = Job<CommentDetectionParams, JobCommentAnnotationResult>;
export type TagDetectionJob = Job<TagDetectionParams, JobTagAnnotationResult>;

/**
 * Discriminated union of all job types
 */
export type AnyJob = DetectionJob | GenerationJob | HighlightDetectionJob | AssessmentDetectionJob | CommentDetectionJob | TagDetectionJob;

/** A job of any type, running: what a claim returns. */
export type RunningAnyJob = Extract<AnyJob, { status: 'running' }>;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Narrow bus-delivered job params to the shape a processor expects.
 *
 * Job params cross the bus as `Record<string, unknown>`. Every params type in
 * this file requires exactly one field — `resourceId` — with the rest
 * optional, so that is what gets verified; absent optionals are legitimately
 * absent, not a validation failure. Callers pass the params type for the job
 * they have already branched on.
 */
export function asJobParams<T extends { resourceId: ResourceId }>(
  params: Record<string, unknown>,
): T {
  if (typeof params.resourceId !== 'string') {
    throw new Error('Job params are missing a resourceId');
  }
  return params as unknown as T;
}

// Generation params are deliberately NOT covered: generation is the one job
// that does not read a source resource (it mints one), so it requires no
// `resourceId` and there is nothing to verify.

export function isPendingJob(job: AnyJob): job is PendingJob<any> {
  return job.status === 'pending';
}

export function isRunningJob(job: AnyJob): job is RunningJob<any> {
  return job.status === 'running';
}

export function isCompleteJob(job: AnyJob): job is CompleteJob<any, any> {
  return job.status === 'complete';
}

export function isFailedJob(job: AnyJob): job is FailedJob<any> {
  return job.status === 'failed';
}

export function isCancelledJob(job: AnyJob): job is CancelledJob<any> {
  return job.status === 'cancelled';
}

