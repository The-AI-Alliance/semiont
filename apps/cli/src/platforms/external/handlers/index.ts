import { apiCheckDescriptor } from './api-check.js';
import { staticCheckDescriptor } from './static-check.js';
import { apiStartDescriptor } from './api-start.js';
import { staticStartDescriptor } from './static-start.js';
import { CheckHandlerContext, CheckHandlerResult, StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All External platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const externalHandlers: Array<
  HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> | 
  HandlerDescriptor<StartHandlerContext, StartHandlerResult>
> = [
  // Check handlers
  apiCheckDescriptor,
  staticCheckDescriptor,
  // Start handlers
  apiStartDescriptor,
  staticStartDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = externalHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';