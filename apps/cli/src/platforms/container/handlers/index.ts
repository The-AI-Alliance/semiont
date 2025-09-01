import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { genericCheckDescriptor } from './generic-check.js';
import { webStartDescriptor } from './web-start.js';
import { databaseStartDescriptor } from './database-start.js';
import { genericStartDescriptor } from './generic-start.js';
import { CheckHandlerContext, CheckHandlerResult, StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Container platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const containerHandlers: Array<
  HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> | 
  HandlerDescriptor<StartHandlerContext, StartHandlerResult>
> = [
  // Check handlers
  webCheckDescriptor,
  databaseCheckDescriptor,
  genericCheckDescriptor,
  // Start handlers
  webStartDescriptor,
  databaseStartDescriptor,
  genericStartDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = containerHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';