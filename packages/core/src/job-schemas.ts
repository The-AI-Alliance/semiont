/**
 * Job Schemas and Types
 *
 * Types for async job operations (entity detection, document generation)
 */

import { z } from 'zod';

/**
 * Job status values
 */
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

/**
 * Job type values
 */
export type JobType = 'detection' | 'generation';

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
  documentId: string;
  documentName: string;
}

/**
 * Job status response
 */
export interface JobStatusResponse {
  jobId: string;
  type: JobType;
  status: JobStatus;
  userId: string;
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  progress?: DetectionProgress | GenerationProgress;
  result?: DetectionResult | GenerationResult;
}

export const JobStatusResponseSchema = z.object({
  jobId: z.string(),
  type: z.enum(['detection', 'generation']),
  status: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']),
  userId: z.string(),
  created: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  progress: z.any().optional(),
  result: z.any().optional(),
});

/**
 * Create job response (returned when creating a job)
 */
export interface CreateJobResponse {
  jobId: string;
  status: JobStatus;
  type: JobType;
  created: string;
}

export const CreateJobResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']),
  type: z.enum(['detection', 'generation']),
  created: z.string(),
});

/**
 * Options for waitForJob helper
 */
export interface WaitForJobOptions {
  pollInterval?: number;  // Default: 500ms
  timeout?: number;       // Default: 300000ms (5 minutes)
  onProgress?: (job: JobStatusResponse) => void;
}
