import { HandlerDescriptor, CheckHandlerContext, CheckHandlerResult } from './types.js';
import { lambdaCheckDescriptor } from './lambda-check.js';
import { ecsCheckDescriptor } from './ecs-check.js';
import { efsCheckDescriptor } from './efs-check.js';
import { rdsCheckDescriptor } from './rds-check.js';
import { s3CloudFrontCheckDescriptor } from './s3-cloudfront-check.js';

/**
 * All AWS handler descriptors
 * Each descriptor explicitly declares its command and service type
 */
export const handlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  lambdaCheckDescriptor,
  ecsCheckDescriptor,
  efsCheckDescriptor,
  rdsCheckDescriptor,
  s3CloudFrontCheckDescriptor,
  // Future handlers will be added here:
  // dynamodb, etc.
];

export * from './types.js';