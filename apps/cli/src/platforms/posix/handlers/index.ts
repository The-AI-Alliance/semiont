import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { workerCheckDescriptor } from './worker-check.js';
import { filesystemCheckDescriptor } from './filesystem-check.js';
import { mcpCheckDescriptor } from './mcp-check.js';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { BaseHandlerContext, HandlerResult } from '../../../core/handlers/types.js';

/**
 * All POSIX platform handler descriptors
 */
// Platform-specific handlers with typed contexts
const posixHandlers: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult>[] = [
  webCheckDescriptor,
  databaseCheckDescriptor,
  workerCheckDescriptor,
  filesystemCheckDescriptor,
  mcpCheckDescriptor
];

// Export as base handler type for registry compatibility
export const handlers = posixHandlers as unknown as HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[];

export * from './types.js';