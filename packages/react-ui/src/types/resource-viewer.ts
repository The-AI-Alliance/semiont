/**
 * Type definitions for resource viewer feature
 */

import type { components, Annotation, ResourceDescriptor } from '@semiont/core';

export type { Annotation };
export type SemiontResource = ResourceDescriptor;
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