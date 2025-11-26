import { databaseCheckDescriptor } from './database-check.js';
import { graphCheckDescriptor } from './graph-check.js';
import { inferenceCheckDescriptor } from './inference-check.js';

/**
 * All External platform handler descriptors
 */
// Export handlers for registry
export const handlers = [
  // Check handlers
  databaseCheckDescriptor,
  graphCheckDescriptor,
  inferenceCheckDescriptor,
  // Start handlers
];

export * from './types.js';