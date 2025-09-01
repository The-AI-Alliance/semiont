import { HandlerDescriptor, CheckHandlerContext, CheckHandlerResult } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';
import { lambdaCheckDescriptor } from './lambda-check.js';
import { ecsCheckDescriptor } from './ecs-check.js';
import { efsCheckDescriptor } from './efs-check.js';
import { rdsCheckDescriptor } from './rds-check.js';
import { s3CloudFrontCheckDescriptor } from './s3-cloudfront-check.js';

/**
 * All AWS handler descriptors
 * Each descriptor explicitly declares its command and service type
 */
// Platform-specific handlers with typed contexts
const awsHandlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  lambdaCheckDescriptor,
  ecsCheckDescriptor,
  efsCheckDescriptor,
  rdsCheckDescriptor,
  s3CloudFrontCheckDescriptor,
  // Future handlers will be added here:
  // dynamodb, etc.
];

// Export as base handler type for registry compatibility
export const handlers = awsHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';