/**
 * Progress type definitions for detection and generation flows
 */

import type { DetectionProgress as ApiDetectionProgress, GenerationProgress as ApiGenerationProgress } from '@semiont/api-client';

/**
 * Detection progress type with frontend-specific extensions
 */
export interface DetectionProgress extends ApiDetectionProgress {
  completedEntityTypes?: Array<{ entityType: string; foundCount: number }>;
}

/**
 * Generation progress type (no extensions needed, re-export API type)
 */
export type GenerationProgress = ApiGenerationProgress;
