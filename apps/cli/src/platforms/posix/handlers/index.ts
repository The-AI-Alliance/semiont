import { databaseCheckDescriptor } from './database-check.js';
import { mcpCheckDescriptor } from './mcp-check.js';
import { graphCheckDescriptor } from './graph-check.js';
import { backendCheckDescriptor } from './backend-check.js';
import { frontendCheckDescriptor } from './frontend-check.js';
import { proxyCheckDescriptor } from './proxy-check.js';
import { databaseStartDescriptor } from './database-start.js';
import { mcpStartDescriptor } from './mcp-start.js';
import { graphStartDescriptor } from './graph-start.js';
import { backendStartDescriptor } from './backend-start.js';
import { frontendStartDescriptor } from './frontend-start.js';
import { proxyStartDescriptor } from './proxy-start.js';
import { mcpProvisionDescriptor } from './mcp-provision.js';
import { graphProvisionDescriptor } from './graph-provision.js';
import { backendProvisionDescriptor } from './backend-provision.js';
import { frontendProvisionDescriptor } from './frontend-provision.js';
import { proxyProvisionDescriptor } from './proxy-provision.js';
import { graphStopDescriptor } from './graph-stop.js';
import { backendStopDescriptor } from './backend-stop.js';
import { frontendStopDescriptor } from './frontend-stop.js';
import { proxyStopDescriptor } from './proxy-stop.js';
import { inferenceCheckDescriptor } from './inference-check.js';
import { inferenceStartDescriptor } from './inference-start.js';
import { inferenceStopDescriptor } from './inference-stop.js';
import { inferenceProvisionDescriptor } from './inference-provision.js';
import type { HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All POSIX platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const posixHandlers: Array<HandlerDescriptor<any, any>> = [
  // Check handlers
  databaseCheckDescriptor,
  mcpCheckDescriptor,
  graphCheckDescriptor,
  backendCheckDescriptor,
  frontendCheckDescriptor,
  proxyCheckDescriptor,
  inferenceCheckDescriptor,
  // Start handlers
  databaseStartDescriptor,
  mcpStartDescriptor,
  graphStartDescriptor,
  backendStartDescriptor,
  frontendStartDescriptor,
  proxyStartDescriptor,
  inferenceStartDescriptor,
  // Stop handlers
  graphStopDescriptor,
  backendStopDescriptor,
  frontendStopDescriptor,
  proxyStopDescriptor,
  inferenceStopDescriptor,
  // Provision handlers
  mcpProvisionDescriptor,
  graphProvisionDescriptor,
  backendProvisionDescriptor,
  frontendProvisionDescriptor,
  proxyProvisionDescriptor,
  inferenceProvisionDescriptor,
];

// Export as base handler type for registry compatibility
export const handlers = posixHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';