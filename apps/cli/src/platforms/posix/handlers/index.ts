import { webCheckDescriptor } from './web-check.js';
import { databaseCheckDescriptor } from './database-check.js';
import { workerCheckDescriptor } from './worker-check.js';
import { filesystemCheckDescriptor } from './filesystem-check.js';
import { mcpCheckDescriptor } from './mcp-check.js';

/**
 * All POSIX platform handler descriptors
 */
export const handlers = [
  webCheckDescriptor,
  databaseCheckDescriptor,
  workerCheckDescriptor,
  filesystemCheckDescriptor,
  mcpCheckDescriptor
];