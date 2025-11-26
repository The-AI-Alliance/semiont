import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { graphCheckDescriptor } from './graph-check.js';
import { webStartDescriptor } from './web-start.js';
import { databaseStartDescriptor } from './database-start.js';
import { graphStartDescriptor } from './graph-start.js';
import { databaseProvisionDescriptor } from './database-provision.js';
import { graphProvisionDescriptor } from './graph-provision.js';
import { graphStopDescriptor } from './graph-stop.js';
import { databaseStopDescriptor } from './database-stop.js';
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
  graphCheckDescriptor,
  // Start handlers
  webStartDescriptor,
  databaseStartDescriptor,
  graphStartDescriptor,
  // Stop handlers
  graphStopDescriptor,
  databaseStopDescriptor,
  // Provision handlers
  databaseProvisionDescriptor,
  graphProvisionDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = containerHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';