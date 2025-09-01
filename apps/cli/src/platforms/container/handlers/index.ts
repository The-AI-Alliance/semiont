import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { genericCheckDescriptor } from './generic-check.js';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Container platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const containerHandlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  webCheckDescriptor,
  databaseCheckDescriptor,
  genericCheckDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = containerHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';