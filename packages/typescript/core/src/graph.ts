/**
 * Graph types
 */

import type { components } from './types';

/** A resource's description, as the spec states it: its `@id` is the resource's `ResourceId`. */
export type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
