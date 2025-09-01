import { HandlerDescriptor, CheckHandlerContext, CheckHandlerResult, StartHandlerContext, StartHandlerResult, ProvisionHandlerContext, ProvisionHandlerResult, PublishHandlerContext, PublishHandlerResult, UpdateHandlerContext, UpdateHandlerResult } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';
import { lambdaCheckDescriptor } from './lambda-check.js';
import { ecsCheckDescriptor } from './ecs-check.js';
import { efsCheckDescriptor } from './efs-check.js';
import { rdsCheckDescriptor } from './rds-check.js';
import { s3CloudFrontCheckDescriptor } from './s3-cloudfront-check.js';
import { ecsFargateStartDescriptor, ecsStartDescriptor } from './ecs-start.js';
import { rdsStartDescriptor } from './rds-start.js';
import { stackProvisionDescriptor } from './stack-provision.js';
import { ecsPublishDescriptor, ecsFargatePublishDescriptor } from './ecs-publish.js';
import { ecsUpdateDescriptor, ecsFargateUpdateDescriptor } from './ecs-update.js';

/**
 * All AWS handler descriptors
 * Each descriptor explicitly declares its command and service type
 */
// Platform-specific handlers with typed contexts
const awsHandlers: Array<
  HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> | 
  HandlerDescriptor<StartHandlerContext, StartHandlerResult> |
  HandlerDescriptor<ProvisionHandlerContext, ProvisionHandlerResult> |
  HandlerDescriptor<PublishHandlerContext, PublishHandlerResult> |
  HandlerDescriptor<UpdateHandlerContext, UpdateHandlerResult>
> = [
  // Check handlers
  lambdaCheckDescriptor,
  ecsCheckDescriptor,
  efsCheckDescriptor,
  rdsCheckDescriptor,
  s3CloudFrontCheckDescriptor,
  // Start handlers
  ecsFargateStartDescriptor,
  ecsStartDescriptor,  // Shorter alias
  rdsStartDescriptor,
  // Provision handlers
  stackProvisionDescriptor,
  // Publish handlers
  ecsPublishDescriptor,
  ecsFargatePublishDescriptor,
  // Update handlers
  ecsUpdateDescriptor,
  ecsFargateUpdateDescriptor,
  // Future handlers will be added here:
  // dynamodb, etc.
];

// Export as base handler type for registry compatibility
export const handlers = awsHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';