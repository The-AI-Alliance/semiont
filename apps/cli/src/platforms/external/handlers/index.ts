import { databaseCheckDescriptor } from './database-check.js';
import { graphCheckDescriptor } from './graph-check.js';
import { inferenceCheckDescriptor } from './inference-check.js';
import { vectorsCheckHandler } from './vectors-check.js';

/**
 * All External platform handler descriptors
 */
export const handlers = [
  databaseCheckDescriptor,
  graphCheckDescriptor,
  inferenceCheckDescriptor,
  vectorsCheckHandler,
];

export * from './types.js';
