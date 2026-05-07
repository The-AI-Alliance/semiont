import {
  defaultCheckDescriptor, frontendCheckDescriptor, databaseCheckDescriptor,
  graphCheckDescriptor, workerCheckDescriptor, inferenceCheckDescriptor,
  mcpCheckDescriptor, stackCheckDescriptor, filesystemCheckDescriptor
} from './default-check.js';
import {
  defaultStartDescriptor, frontendStartDescriptor, databaseStartDescriptor,
  graphStartDescriptor, workerStartDescriptor, inferenceStartDescriptor,
  mcpStartDescriptor, stackStartDescriptor, filesystemStartDescriptor
} from './default-start.js';
import type { HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Mock platform handler descriptors — one per (command, serviceType) pair
 */
// Platform-specific handlers with typed contexts
const mockHandlers: Array<HandlerDescriptor<any, any>> = [
  // Check handlers (one per logical service type)
  defaultCheckDescriptor,    // backend
  frontendCheckDescriptor,
  databaseCheckDescriptor,
  graphCheckDescriptor,
  workerCheckDescriptor,
  inferenceCheckDescriptor,
  mcpCheckDescriptor,
  stackCheckDescriptor,
  filesystemCheckDescriptor,
  // Start handlers (one per logical service type)
  defaultStartDescriptor,    // backend
  frontendStartDescriptor,
  databaseStartDescriptor,
  graphStartDescriptor,
  workerStartDescriptor,
  inferenceStartDescriptor,
  mcpStartDescriptor,
  stackStartDescriptor,
  filesystemStartDescriptor,
];

// Export as base handler type for registry compatibility
export const handlers = mockHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';
