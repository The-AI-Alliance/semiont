import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { genericCheckDescriptor } from './generic-check.js';
import { graphCheckDescriptor } from './graph-check.js';
import { webStartDescriptor } from './web-start.js';
import { databaseStartDescriptor } from './database-start.js';
import { genericStartDescriptor } from './generic-start.js';
import { graphStartDescriptor } from './graph-start.js';
import { genericProvisionDescriptor } from './generic-provision.js';
import { databaseProvisionDescriptor } from './database-provision.js';
import { graphProvisionDescriptor } from './graph-provision.js';
import { genericPublishDescriptor } from './generic-publish.js';
import { genericUpdateDescriptor } from './generic-update.js';
import { graphStopDescriptor } from './graph-stop.js';
import { databaseStopDescriptor } from './database-stop.js';
import { genericStopDescriptor } from './generic-stop.js';
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
  graphCheckDescriptor,
  // Start handlers
  webStartDescriptor,
  databaseStartDescriptor,
  genericStartDescriptor,
  graphStartDescriptor,
  // Stop handlers
  graphStopDescriptor,
  databaseStopDescriptor,
  genericStopDescriptor,
  // Provision handlers
  genericProvisionDescriptor,
  databaseProvisionDescriptor,
  graphProvisionDescriptor,
  // Publish handlers
  genericPublishDescriptor,
  // Update handlers
  genericUpdateDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = containerHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';