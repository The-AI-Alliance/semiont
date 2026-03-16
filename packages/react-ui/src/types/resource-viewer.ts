/**
 * Type definitions for resource viewer feature
 */

import type { components } from '@semiont/core';

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