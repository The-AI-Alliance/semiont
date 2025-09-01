import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { genericCheckDescriptor } from './generic-check.js';

/**
 * All Container platform handler descriptors
 */
export const handlers = [
  webCheckDescriptor,
  databaseCheckDescriptor,
  genericCheckDescriptor
];