import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { genericCheckDescriptor } from './generic-check.js';
import { webStartDescriptor } from './web-start.js';
import { databaseStartDescriptor } from './database-start.js';
import { genericStartDescriptor } from './generic-start.js';
import { genericProvisionDescriptor } from './generic-provision.js';
import { genericPublishDescriptor } from './generic-publish.js';
import { genericUpdateDescriptor } from './generic-update.js';
import { 
  CheckHandlerContext, CheckHandlerResult, 
  StartHandlerContext, StartHandlerResult,
  ProvisionHandlerContext, ProvisionHandlerResult,
  PublishHandlerContext, PublishHandlerResult,
  UpdateHandlerContext, UpdateHandlerResult,
  HandlerDescriptor 
} from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Container platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const containerHandlers: Array<
  HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> | 
  HandlerDescriptor<StartHandlerContext, StartHandlerResult> |
  HandlerDescriptor<ProvisionHandlerContext, ProvisionHandlerResult> |
  HandlerDescriptor<PublishHandlerContext, PublishHandlerResult> |
  HandlerDescriptor<UpdateHandlerContext, UpdateHandlerResult>
> = [
  // Check handlers
  webCheckDescriptor,
  databaseCheckDescriptor,
  genericCheckDescriptor,
  // Start handlers
  webStartDescriptor,
  databaseStartDescriptor,
  genericStartDescriptor,
  // Provision handlers
  genericProvisionDescriptor,
  // Publish handlers
  genericPublishDescriptor,
  // Update handlers
  genericUpdateDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = containerHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';