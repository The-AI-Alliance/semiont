/**
 * Job Queue Type Definitions
 *
 * Jobs represent async work that can be queued, processed, and monitored.
 * They are completely independent of HTTP request/response cycles.
 */

import type { components } from '@semiont/api-client';
import type { ResourceId, UserId } from '@semiont/core';

type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];

export type JobType = 'detection' | 'generation';
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

/**
 * Base job interface - all jobs extend this
 */
export interface BaseJob {
  id: string;
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
  entityTypes: string[];
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
  referenceId: string;
  sourceResourceId: ResourceId;
  prompt?: string;
  title?: string;
  entityTypes?: string[];
  language?: string;
  llmContext?: AnnotationLLMContextResponse;  // Pre-fetched context from annotation-llm-context endpoint
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
 * Discriminated union of all job types
 */
export type Job = DetectionJob | GenerationJob;

/**
 * Job creation request types (without server-generated fields)
 */
export interface CreateDetectionJobRequest {
  resourceId: ResourceId;
  entityTypes: string[];
}

export interface CreateGenerationJobRequest {
  referenceId: string;
  sourceResourceId: ResourceId;
  prompt?: string;
  title?: string;
  entityTypes?: string[];
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
  jobId: string;
}

export interface ListJobsResponse {
  jobs: Job[];
  total: number;
}
