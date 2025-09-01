import { defaultCheckDescriptor } from './default-check.js';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Mock platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const mockHandlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  defaultCheckDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = mockHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';