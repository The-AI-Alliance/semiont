import { apiCheckDescriptor } from './api-check.js';
import { staticCheckDescriptor } from './static-check.js';

/**
 * All External platform handler descriptors
 */
export const handlers = [
  apiCheckDescriptor,
  staticCheckDescriptor
];