// Service architecture exports

export * from './types.js';
export type { ServiceName } from '../core/service-discovery.js';
// Result types are now exported from their respective command files
export * from '../core/commands/start.js';
export * from '../core/commands/stop.js';
export * from '../core/commands/check.js';
export * from '../core/commands/update.js';
export * from '../core/commands/provision.js';
export * from '../core/commands/publish.js';
export * from '../core/commands/backup.js';
export * from '../core/commands/exec.js';
export * from '../core/commands/test.js';
export * from '../core/commands/restore.js';
export * from '../core/base-service.js';
export * from './service-factory.js';

// Individual service exports (for testing or direct use)
export * from './backend-service.js';
export * from './frontend-service.js';
export * from './database-service.js';
export * from './filesystem-service.js';
export * from './mcp-service.js';