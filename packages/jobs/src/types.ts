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

import type { JobId, EntityType, ResourceId, UserId, AnnotationId, GatheredContext, TagSchema, SupportedMediaType } from '@semiont/core';

export type JobType = 'reference-annotation' | 'generation' | 'highlight-annotation' | 'assessment-annotation' | 'comment-annotation' | 'tag-annotation';
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

// ============================================================================
// Core Metadata and Parameters
// ============================================================================

/**
 * Job metadata - common to all states
 */
export interface JobMetadata {
  id: JobId;
  type: JobType;
  userId: UserId;
  /**
   * Audit-only snapshot of the requesting user (with `userEmail` and
   * `userDomain` below), stamped at job creation and persisted in the
   * on-disk job file. No code path reads these back — annotation
   * `creator` attribution is derived from `userId` via `didToAgent()`.
   * Kept intentionally so job files are self-describing to a human.
   */
  userName: string;
  userEmail: string;
  userDomain: string;
  created: string;
  retryCount: number;
  maxRetries: number;
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
export interface DetectionParams {
  resourceId: ResourceId;
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
}

/**
 * Generation job parameters
 */
export interface GenerationParams {
  /**
   * The unresolved reference an annotation-focus generation was triggered from.
   * Absent for resource-focus generation (`yield.fromResource`). When present, the
   * worker auto-binds the new resource to it; when absent, provenance is a minted
   * source→derived reference annotation (Fork 2b).
   */
  referenceId?: AnnotationId;
  prompt?: string;
  title?: string;
  entityTypes?: EntityType[];
  /** Annotation body locale — language the *generated resource* is written in. */
  language?: string;
  /**
   * Source-resource locale — language of the resource being referenced.
   * Used in the prompt so the LLM understands the embedded source-context
   * snippet correctly when source ≠ target language.
   */
  sourceLanguage?: string;
  context?: GatheredContext;
  temperature?: number;
  maxTokens?: number;
  storageUri?: string;
  /**
   * Requested media type of the generated resource's content. Default `text/markdown`.
   * The generation worker produces `text/markdown` and `text/plain`; any other value
   * fails the job (no silent fallback) — Semiont is multi-modal at the core, but
   * generation coverage is text-only for now and the gap is surfaced, not hidden.
   */
  outputMediaType?: SupportedMediaType;
  /**
   * What the model is asked to DO — the prompt's framing verb. Canonical values map
   * to tested framings; any other string is used verbatim as the framing instruction
   * (loud degrade: the worker warns, never silently falls back to 'resource').
   * Default 'resource'. See .plans/YIELD-STRUCTURE.md.
   */
  task?: 'resource' | 'answer' | 'summary' | (string & {});
  /**
   * How the output is internally segmented — text-bearing shape, subordinate to
   * `outputMediaType` (never its peer). Canonical values map to tested guidance; any
   * other string becomes a freeform "Organize the output as: …" instruction (loud
   * degrade). UNSET means NO structure directive is emitted — the task framing and
   * the model determine shape. See .plans/YIELD-STRUCTURE.md D2/D5.
   */
  structure?: 'prose' | 'sections' | 'chat' | (string & {});
  /**
   * Ask the model to cite: emit `[[<id>]]` transport tokens after each claim, using
   * the ids the context embedding provides (CONTEXT-IDENTIFIERS). The worker
   * validates each id against the embedded context (unknown ids are dropped
   * loudly), strips the tokens from the stored content, and mints W3C linking
   * annotations on the derived resource. See .plans/INLINE-CITATIONS.md.
   */
  cite?: boolean;
}

/**
 * Highlight detection job parameters
 */
export interface HighlightDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
  density?: number;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
}

/**
 * Assessment detection job parameters
 */
export interface AssessmentDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';
  density?: number;
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
}

/**
 * Comment detection job parameters
 */
export interface CommentDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  density?: number;
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
}

/**
 * Tag detection job parameters.
 *
 * Carries the *full* `TagSchema` (not just an id). The dispatcher resolves
 * the caller-supplied `schemaId` against the per-KB tag-schema projection
 * at job-creation time and embeds the resolved schema here, keeping the
 * worker independent of the registry.
 */
export interface TagDetectionParams {
  resourceId: ResourceId;
  schema: TagSchema;
  categories: string[];
  /** Annotation body locale — see locale conventions above. */
  language?: string;
  /** Source-resource locale — see locale conventions above. */
  sourceLanguage?: string;
}

// ============================================================================
// Progress and Result Types
// ============================================================================

/**
 * Detection job progress
 */
export interface DetectionProgress {
  totalEntityTypes: number;
  processedEntityTypes: number;
  currentEntityType?: string;
  entitiesFound: number;
  entitiesEmitted: number;
}

/**
 * Detection job result
 */
export interface DetectionResult {
  totalFound: number;
  totalEmitted: number;
  errors: number;
}

/**
 * Generation job progress
 */
export interface YieldProgress {
  /** The two real generation transitions — LLM call running, then persisting. */
  stage: 'generating' | 'creating';
  percentage: number;
  message?: string;
}

/**
 * Generation job result
 */
export interface GenerationResult {
  resourceId: ResourceId;
  resourceName: string;
}

/**
 * Highlight detection job progress
 */
export interface HighlightDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  message?: string;
}

/**
 * Highlight detection job result
 */
export interface HighlightDetectionResult {
  highlightsFound: number;
  highlightsCreated: number;
}

/**
 * Assessment detection job progress
 */
export interface AssessmentDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  message?: string;
}

/**
 * Assessment detection job result
 */
export interface AssessmentDetectionResult {
  assessmentsFound: number;
  assessmentsCreated: number;
}

/**
 * Comment detection job progress
 */
export interface CommentDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  message?: string;
}

/**
 * Comment detection job result
 */
export interface CommentDetectionResult {
  commentsFound: number;
  commentsCreated: number;
}

/**
 * Tag detection job progress
 */
export interface TagDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  currentCategory?: string;
  processedCategories: number;
  totalCategories: number;
  message?: string;
}

/**
 * Tag detection job result
 */
export interface TagDetectionResult {
  tagsFound: number;
  tagsCreated: number;
  byCategory: Record<string, number>;
}

// ============================================================================
// Generic Job State Types
// ============================================================================

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
export interface RunningJob<P, PG> {
  status: 'running';
  metadata: JobMetadata;
  params: P;
  startedAt: string;
  progress: PG;
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
export type Job<P, PG, R> =
  | PendingJob<P>
  | RunningJob<P, PG>
  | CompleteJob<P, R>
  | FailedJob<P>
  | CancelledJob<P>;

// ============================================================================
// Concrete Job Types
// ============================================================================

export type DetectionJob = Job<DetectionParams, DetectionProgress, DetectionResult>;
export type GenerationJob = Job<GenerationParams, YieldProgress, GenerationResult>;
export type HighlightDetectionJob = Job<HighlightDetectionParams, HighlightDetectionProgress, HighlightDetectionResult>;
export type AssessmentDetectionJob = Job<AssessmentDetectionParams, AssessmentDetectionProgress, AssessmentDetectionResult>;
export type CommentDetectionJob = Job<CommentDetectionParams, CommentDetectionProgress, CommentDetectionResult>;
export type TagDetectionJob = Job<TagDetectionParams, TagDetectionProgress, TagDetectionResult>;

/**
 * Discriminated union of all job types
 */
export type AnyJob = DetectionJob | GenerationJob | HighlightDetectionJob | AssessmentDetectionJob | CommentDetectionJob | TagDetectionJob;

// ============================================================================
// Type Guards
// ============================================================================

export function isPendingJob(job: AnyJob): job is PendingJob<any> {
  return job.status === 'pending';
}

export function isRunningJob(job: AnyJob): job is RunningJob<any, any> {
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

// ============================================================================
// Job Query Types
// ============================================================================

export interface JobQueryFilters {
  status?: JobStatus;
  type?: JobType;
  userId?: UserId;
  limit?: number;
  offset?: number;
}

