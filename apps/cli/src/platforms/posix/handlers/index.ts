import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { workerCheckDescriptor } from './worker-check.js';
import { filesystemCheckDescriptor } from './filesystem-check.js';
import { mcpCheckDescriptor } from './mcp-check.js';
import { webStartDescriptor } from './web-start.js';
import { databaseStartDescriptor } from './database-start.js';
import { workerStartDescriptor } from './worker-start.js';
import { filesystemStartDescriptor } from './filesystem-start.js';
import { mcpStartDescriptor } from './mcp-start.js';
import { CheckHandlerContext, CheckHandlerResult, StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All POSIX platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const posixHandlers: Array<
  HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> | 
  HandlerDescriptor<StartHandlerContext, StartHandlerResult>
> = [
  // Check handlers
  webCheckDescriptor,
  databaseCheckDescriptor,
  workerCheckDescriptor,
  filesystemCheckDescriptor,
  mcpCheckDescriptor,
  // Start handlers
  webStartDescriptor,
  databaseStartDescriptor,
  workerStartDescriptor,
  filesystemStartDescriptor,
  mcpStartDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = posixHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';