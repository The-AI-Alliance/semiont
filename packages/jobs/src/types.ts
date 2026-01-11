/**
 * Job Queue Type Definitions
 *
 * Jobs represent async work that can be queued, processed, and monitored.
 * They are completely independent of HTTP request/response cycles.
 */

import type { GenerationContext } from '@semiont/api-client';
import type { JobId, EntityType } from '@semiont/api-client';
import type { ResourceId, UserId, AnnotationId } from '@semiont/core';

export type JobType = 'detection' | 'generation' | 'highlight-detection' | 'assessment-detection' | 'comment-detection' | 'tag-detection';
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

/**
 * Base job interface - all jobs extend this
 */
export interface BaseJob {
  id: JobId;
  type: JobType;
  status: JobStatus;
  userId: UserId;
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

/**
 * Detection job - finds entities in a resource using AI inference
 */
export interface DetectionJob extends BaseJob {
  type: 'detection';
  resourceId: ResourceId;
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;  // Include anaphoric/cataphoric references (e.g., "the CEO", "the tech giant")
  progress?: {
    totalEntityTypes: number;
    processedEntityTypes: number;
    currentEntityType?: string;
    entitiesFound: number;
    entitiesEmitted: number;
  };
  result?: {
    totalFound: number;
    totalEmitted: number;
    errors: number;
  };
}

/**
 * Generation job - generates a new resource using AI inference
 */
export interface GenerationJob extends BaseJob {
  type: 'generation';
  referenceId: AnnotationId;
  sourceResourceId: ResourceId;
  prompt?: string;
  title?: string;
  entityTypes?: EntityType[];
  language?: string;
  context?: GenerationContext;  // Generation context (required for generation to proceed)
  temperature?: number;         // AI inference temperature (0.0-1.0)
  maxTokens?: number;           // Maximum tokens to generate
  progress?: {
    stage: 'fetching' | 'generating' | 'creating' | 'linking';
    percentage: number;
    message?: string;
  };
  result?: {
    resourceId: ResourceId;
    resourceName: string;
  };
}

/**
 * Highlight Detection job - finds passages to highlight using AI
 */
export interface HighlightDetectionJob extends BaseJob {
  type: 'highlight-detection';
  resourceId: ResourceId;
  instructions?: string;  // Optional user instructions for AI
  density?: number;  // Optional: desired number of highlights per 2000 words (1-15)
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    message?: string;
  };
  result?: {
    highlightsFound: number;
    highlightsCreated: number;
  };
}

/**
 * Assessment Detection job - evaluates passages using AI
 */
export interface AssessmentDetectionJob extends BaseJob {
  type: 'assessment-detection';
  resourceId: ResourceId;
  instructions?: string;  // Optional user instructions for AI
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';  // Optional tone/style
  density?: number;  // Optional: desired number of assessments per 2000 words (1-10)
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    message?: string;
  };
  result?: {
    assessmentsFound: number;
    assessmentsCreated: number;
  };
}

/**
 * Comment Detection job - generates explanatory comments on passages using AI
 */
export interface CommentDetectionJob extends BaseJob {
  type: 'comment-detection';
  resourceId: ResourceId;
  instructions?: string;  // Optional user instructions for AI
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';  // Optional tone/style
  density?: number;  // Optional: desired number of comments per 2000 words (2-12)
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    message?: string;
  };
  result?: {
    commentsFound: number;
    commentsCreated: number;
  };
}

/**
 * Tag Detection job - identifies passages serving structural roles using AI
 */
export interface TagDetectionJob extends BaseJob {
  type: 'tag-detection';
  resourceId: ResourceId;
  schemaId: string;  // e.g., 'legal-irac', 'scientific-imrad'
  categories: string[];  // e.g., ['Issue', 'Rule', 'Application', 'Conclusion']
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    currentCategory?: string;  // Category currently being processed
    processedCategories: number;
    totalCategories: number;
    message?: string;
  };
  result?: {
    tagsFound: number;
    tagsCreated: number;
    byCategory: Record<string, number>;  // e.g., { "Issue": 1, "Rule": 2 }
  };
}

/**
 * Discriminated union of all job types
 */
export type Job = DetectionJob | GenerationJob | HighlightDetectionJob | AssessmentDetectionJob | CommentDetectionJob | TagDetectionJob;

/**
 * Job creation request types (without server-generated fields)
 */
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

/**
 * Job query filters
 */
export interface JobQueryFilters {
  status?: JobStatus;
  type?: JobType;
  userId?: UserId;
  limit?: number;
  offset?: number;
}

/**
 * Job API response types
 */
export interface CreateJobResponse {
  jobId: JobId;
}

export interface ListJobsResponse {
  jobs: Job[];
  total: number;
}
