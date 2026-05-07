import { databaseCheckDescriptor } from './database-check.js';
import { embeddingCheckDescriptor } from './embedding-check.js';
import { embeddingProvisionDescriptor } from './embedding-provision.js';
import { graphCheckDescriptor } from './graph-check.js';
import { inferenceCheckDescriptor } from './inference-check.js';
import { inferenceProvisionDescriptor } from './inference-provision.js';
import { vectorsCheckDescriptor } from './vectors-check.js';

/**
 * All External platform handler descriptors
 */
export const handlers = [
  databaseCheckDescriptor,
  embeddingCheckDescriptor,
  embeddingProvisionDescriptor,
  graphCheckDescriptor,
  inferenceCheckDescriptor,
  inferenceProvisionDescriptor,
  vectorsCheckDescriptor,
];

export * from './types.js';
