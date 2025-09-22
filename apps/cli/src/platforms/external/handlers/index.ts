import { graphCheckDescriptor } from './graph-check.js';
import { inferenceCheckDescriptor } from './inference-check.js';
import type { HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All External platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const externalHandlers: Array<HandlerDescriptor<any, any>> = [
  // Check handlers
  graphCheckDescriptor,
  inferenceCheckDescriptor,
  // Start handlers
];

// Export as base handler type for registry compatibility
export const handlers = externalHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';