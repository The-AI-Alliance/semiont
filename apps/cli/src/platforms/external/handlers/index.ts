import { apiCheckDescriptor } from './api-check.js';
import { staticCheckDescriptor } from './static-check.js';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All External platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const externalHandlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  apiCheckDescriptor,
  staticCheckDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = externalHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';