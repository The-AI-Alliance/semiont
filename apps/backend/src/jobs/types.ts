/**
 * Job Queue Type Definitions
 *
 * Jobs represent async work that can be queued, processed, and monitored.
 * They are completely independent of HTTP request/response cycles.
 */

export type JobType = 'detection' | 'generation';
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

/**
 * Base job interface - all jobs extend this
 */
export interface BaseJob {
  id: string;
  type: JobType;
  status: JobStatus;
  userId: string;
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

/**
 * Detection job - finds entities in a document using AI inference
 */
export interface DetectionJob extends BaseJob {
  type: 'detection';
  documentId: string;
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
 * Generation job - generates a new document using AI inference
 */
export interface GenerationJob extends BaseJob {
  type: 'generation';
  referenceId: string;
  sourceDocumentId: string;
  prompt?: string;
  title?: string;
  entityTypes?: string[];
  language?: string;
  progress?: {
    stage: 'fetching' | 'generating' | 'creating' | 'linking';
    percentage: number;
    message?: string;
  };
  result?: {
    documentId: string;
    documentName: string;
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
  documentId: string;
  entityTypes: string[];
}

export interface CreateGenerationJobRequest {
  referenceId: string;
  sourceDocumentId: string;
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
  userId?: string;
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
