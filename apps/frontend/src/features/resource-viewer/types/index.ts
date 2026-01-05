/**
 * Type definitions for resource viewer feature
 */

import type { components, ResourceUri, ContentFormat, GenerationContext } from '@semiont/api-client';

export type SemiontResource = components['schemas']['ResourceDescriptor'];
export type Annotation = components['schemas']['Annotation'];
export type Motivation = components['schemas']['Motivation'];

/**
 * Selection for creating annotations
 */
export interface TextSelection {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  svgSelector?: string;
}

/**
 * Detection progress state
 */
export interface DetectionProgress {
  status: string;
  percentage?: number;
  message?: string;
  currentCategory?: string;
  processedCategories?: number;
  totalCategories?: number;
}

/**
 * Generation options
 */
export interface GenerationOptions {
  title: string;
  prompt?: string;
  language?: string;
  temperature?: number;
  maxTokens?: number;
  context?: GenerationContext;
}
