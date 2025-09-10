import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { workerCheckDescriptor } from './worker-check.js';
import { filesystemCheckDescriptor } from './filesystem-check.js';
import { mcpCheckDescriptor } from './mcp-check.js';
import { graphCheckDescriptor } from './graph-check.js';
import { backendCheckDescriptor } from './backend-check.js';
import { frontendCheckDescriptor } from './frontend-check.js';
import { webStartDescriptor } from './web-start.js';
import { databaseStartDescriptor } from './database-start.js';
import { workerStartDescriptor } from './worker-start.js';
import { filesystemStartDescriptor } from './filesystem-start.js';
import { mcpStartDescriptor } from './mcp-start.js';
import { graphStartDescriptor } from './graph-start.js';
import { backendStartDescriptor } from './backend-start.js';
import { frontendStartDescriptor } from './frontend-start.js';
import { mcpProvisionDescriptor } from './mcp-provision.js';
import { filesystemProvisionDescriptor } from './filesystem-provision.js';
import { graphProvisionDescriptor } from './graph-provision.js';
import { backendProvisionDescriptor } from './backend-provision.js';
import { frontendProvisionDescriptor } from './frontend-provision.js';
import { graphStopDescriptor } from './graph-stop.js';
import { filesystemStopDescriptor } from './filesystem-stop.js';
import { backendStopDescriptor } from './backend-stop.js';
import { frontendStopDescriptor } from './frontend-stop.js';
import type { HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All POSIX platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const posixHandlers: Array<HandlerDescriptor<any, any>> = [
  // Check handlers
  webCheckDescriptor,
  databaseCheckDescriptor,
  workerCheckDescriptor,
  filesystemCheckDescriptor,
  mcpCheckDescriptor,
  graphCheckDescriptor,
  backendCheckDescriptor,
  frontendCheckDescriptor,
  // Start handlers
  webStartDescriptor,
  databaseStartDescriptor,
  workerStartDescriptor,
  filesystemStartDescriptor,
  mcpStartDescriptor,
  graphStartDescriptor,
  backendStartDescriptor,
  frontendStartDescriptor,
  // Stop handlers
  graphStopDescriptor,
  filesystemStopDescriptor,
  backendStopDescriptor,
  frontendStopDescriptor,
  // Provision handlers
  mcpProvisionDescriptor,
  filesystemProvisionDescriptor,
  graphProvisionDescriptor,
  backendProvisionDescriptor,
  frontendProvisionDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = posixHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';