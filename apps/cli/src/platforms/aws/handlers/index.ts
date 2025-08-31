import { HandlerDescriptor, CheckHandlerContext, CheckHandlerResult } from './types.js';
import { lambdaCheckDescriptor } from './lambda-check.js';
import { ecsCheckDescriptor } from './ecs-check.js';
import { efsCheckDescriptor } from './efs-check.js';

/**
 * All AWS handler descriptors
 * Each descriptor explicitly declares its command and service type
 */
export const handlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  lambdaCheckDescriptor,
  ecsCheckDescriptor,
  efsCheckDescriptor,
  // Future handlers will be added here:
  // rdsCheckDescriptor,
  // etc.
];

export * from './types.js';