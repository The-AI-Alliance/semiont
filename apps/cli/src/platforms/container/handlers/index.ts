import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { genericCheckDescriptor } from './generic-check.js';
import { webStartDescriptor } from './web-start.js';
import { databaseStartDescriptor } from './database-start.js';
import { genericStartDescriptor } from './generic-start.js';
import { graphStartDescriptor } from './graph-start.js';
import { genericProvisionDescriptor } from './generic-provision.js';
import { janusgraphProvisionDescriptor } from './graph-provision.js';
import { genericPublishDescriptor } from './generic-publish.js';
import { genericUpdateDescriptor } from './generic-update.js';
import type { HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All Container platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const containerHandlers: Array<HandlerDescriptor<any, any>> = [
  // Check handlers
  webCheckDescriptor,
  databaseCheckDescriptor,
  genericCheckDescriptor,
  // Start handlers
  webStartDescriptor,
  databaseStartDescriptor,
  genericStartDescriptor,
  graphStartDescriptor,
  // Provision handlers
  genericProvisionDescriptor,
  janusgraphProvisionDescriptor,
  // Publish handlers
  genericPublishDescriptor,
  // Update handlers
  genericUpdateDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = containerHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';