import { defaultCheckDescriptor } from './default-check.js';
import { defaultStartDescriptor } from './default-start.js';
import { CheckHandlerContext, CheckHandlerResult, StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Mock platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const mockHandlers: Array<
  HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> | 
  HandlerDescriptor<StartHandlerContext, StartHandlerResult>
> = [
  // Check handlers
  defaultCheckDescriptor,
  // Start handlers
  defaultStartDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = mockHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';