import { defaultCheckDescriptor } from './default-check.js';
import { defaultStartDescriptor } from './default-start.js';
import type { HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Mock platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const mockHandlers: Array<HandlerDescriptor<any, any>> = [
  // Check handlers
  defaultCheckDescriptor,
  // Start handlers
  defaultStartDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = mockHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';