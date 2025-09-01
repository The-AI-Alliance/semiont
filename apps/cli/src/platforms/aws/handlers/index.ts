import { HandlerDescriptor, CheckHandlerContext, CheckHandlerResult, StartHandlerContext, StartHandlerResult } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';
import { lambdaCheckDescriptor } from './lambda-check.js';
import { ecsCheckDescriptor } from './ecs-check.js';
import { efsCheckDescriptor } from './efs-check.js';
import { rdsCheckDescriptor } from './rds-check.js';
import { s3CloudFrontCheckDescriptor } from './s3-cloudfront-check.js';
import { ecsFargateStartDescriptor } from './ecs-fargate-start.js';
import { rdsStartDescriptor } from './rds-start.js';

/**
 * All AWS handler descriptors
 * Each descriptor explicitly declares its command and service type
 */
// Platform-specific handlers with typed contexts
const awsHandlers: Array<
  HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> | 
  HandlerDescriptor<StartHandlerContext, StartHandlerResult>
> = [
  // Check handlers
  lambdaCheckDescriptor,
  ecsCheckDescriptor,
  efsCheckDescriptor,
  rdsCheckDescriptor,
  s3CloudFrontCheckDescriptor,
  // Start handlers
  ecsFargateStartDescriptor,
  rdsStartDescriptor,
  // Future handlers will be added here:
  // dynamodb, etc.
];

// Export as base handler type for registry compatibility
export const handlers = awsHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';