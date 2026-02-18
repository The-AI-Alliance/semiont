/**
 * Progress type definitions for detection and generation flows
 */

import type { GenerationProgress as ApiGenerationProgress } from '@semiont/api-client';

/**
 * Common detection progress fields shared across all motivation types.
 *
 * The five motivations have different SSE progress shapes
 * (ReferenceDetectionProgress uses entity-type steps; the others use percentage).
 * This local type captures the subset of fields used by the detection UI
 * (DetectionProgressWidget, useDetectionFlow).
 */
export interface DetectionProgress {
  status: string;
  message?: string;
  /** Reference detection: currently scanning entity type */
  currentEntityType?: string;
  /** Reference detection: completed entity types with counts (frontend-only) */
  completedEntityTypes?: Array<{ entityType: string; foundCount: number }>;
  /** Percentage-based motivations (highlight, assessment, comment, tag) */
  percentage?: number;
  /** Category-based motivations (tag) */
  currentCategory?: string;
  processedCategories?: number;
  totalCategories?: number;
  /** Request parameters for display in progress UI (frontend-only, added by annotation-registry) */
  requestParams?: Array<{ label: string; value: string }>;
}

/**
 * Generation progress type (no extensions needed, re-export API type)
 */
export type GenerationProgress = ApiGenerationProgress;
