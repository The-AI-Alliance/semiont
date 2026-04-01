import type { HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';
import { lambdaCheckDescriptor } from './lambda-check.js';
import { ecsCheckDescriptor } from './ecs-check.js';
import { rdsCheckDescriptor } from './rds-check.js';
import { s3CloudFrontCheckDescriptor } from './s3-cloudfront-check.js';
import { neptuneCheckDescriptor } from './neptune-check.js';
import { efsCheckDescriptor } from './efs-check.js';
import { ecsFargateStartDescriptor } from './ecs-start.js';
import { rdsStartDescriptor } from './rds-start.js';
import { stackProvisionDescriptor } from './stack-provision.js';
import { ecsPublishDescriptor } from './ecs-publish.js';
import { ecsUpdateDescriptor } from './ecs-update.js';

/**
 * All AWS handler descriptors
 * Each descriptor explicitly declares its command and service type
 */
// Platform-specific handlers with typed contexts
const awsHandlers: Array<HandlerDescriptor<any, any>> = [
  // Check handlers
  lambdaCheckDescriptor,        // worker
  ecsCheckDescriptor,           // backend
  rdsCheckDescriptor,           // database
  s3CloudFrontCheckDescriptor,  // frontend
  neptuneCheckDescriptor,       // graph
  efsCheckDescriptor,           // filesystem
  // Start handlers
  ecsFargateStartDescriptor,    // backend
  rdsStartDescriptor,           // database
  // Provision handlers
  stackProvisionDescriptor,
  // Publish handlers
  ecsPublishDescriptor,         // backend
  // Update handlers
  ecsUpdateDescriptor,          // backend
];

// Export as base handler type for registry compatibility
export const handlers = awsHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';