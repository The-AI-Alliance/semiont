import { HandlerDescriptor, CheckHandlerContext, CheckHandlerResult } from './types.js';
import { lambdaCheckDescriptor } from './lambda-check.js';

/**
 * All AWS handler descriptors
 * Each descriptor explicitly declares its command and service type
 */
export const handlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  lambdaCheckDescriptor,
  // Future handlers will be added here:
  // ecsCheckDescriptor,
  // rdsCheckDescriptor,
  // etc.
];

export * from './types.js';