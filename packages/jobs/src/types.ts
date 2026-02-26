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

import type { JobId, EntityType, ResourceId, UserId, AnnotationId, GenerationContext } from '@semiont/core';


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
  created: string;
  retryCount: number;
  maxRetries: number;
}

/**
 * Detection job parameters
 */
export interface DetectionParams {
  resourceId: ResourceId;
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;
}

/**
 * Generation job parameters
 */
export interface GenerationParams {
  referenceId: AnnotationId;
  sourceResourceId: ResourceId;
  prompt?: string;
  title?: string;
  entityTypes?: EntityType[];
  language?: string;
  context?: GenerationContext;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Highlight detection job parameters
 */
export interface HighlightDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
  density?: number;
}

/**
 * Assessment detection job parameters
 */
export interface AssessmentDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';
  density?: number;
}

/**
 * Comment detection job parameters
 */
export interface CommentDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  density?: number;
}

/**
 * Tag detection job parameters
 */
export interface TagDetectionParams {
  resourceId: ResourceId;
  schemaId: string;
  categories: string[];
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
export interface GenerationProgress {
  stage: 'fetching' | 'generating' | 'creating' | 'linking';
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
export type GenerationJob = Job<GenerationParams, GenerationProgress, GenerationResult>;
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
// Job Creation Request Types
// ============================================================================

export interface CreateDetectionJobRequest {
  resourceId: ResourceId;
  entityTypes: EntityType[];
}

export interface CreateGenerationJobRequest {
  referenceId: AnnotationId;
  sourceResourceId: ResourceId;
  prompt?: string;
  title?: string;
  entityTypes?: EntityType[];
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

// ============================================================================
// Job API Response Types
// ============================================================================

export interface CreateJobResponse {
  jobId: JobId;
}

export interface ListJobsResponse {
  jobs: AnyJob[];
  total: number;
}
