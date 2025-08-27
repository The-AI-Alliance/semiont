/**
 * Core Service Interface
 * 
 * Defines the contract that all services must implement.
 * Each service (backend, frontend, database, etc.) implements this interface.
 */

import type { Platform } from '../lib/platform-resolver.js';
import type { StartResult } from '../commands/start.js';
import type { StopResult } from '../commands/stop.js';
import type { CheckResult } from '../commands/check.js';
import type { UpdateResult } from '../commands/update.js';
import type { ProvisionResult } from '../commands/provision.js';
import type { PublishResult } from '../commands/publish.js';
import type { BackupResult } from '../commands/backup.js';
import type { ExecResult, ExecOptions } from '../commands/exec.js';
import type { TestResult, TestOptions } from '../commands/test.js';
import type { RestoreResult, RestoreOptions } from '../commands/restore.js';

/**
 * Available service types in the system
 */
export type ServiceName = 'backend' | 'frontend' | 'database' | 'filesystem' | 'mcp' | 'agent';

/**
 * Core service interface that all services implement
 */
export interface Service {
  readonly name: ServiceName;
  readonly platform: Platform;
  
  start(): Promise<StartResult>;
  stop(): Promise<StopResult>;
  check(): Promise<CheckResult>;
  update(): Promise<UpdateResult>;
  provision(): Promise<ProvisionResult>;
  publish(): Promise<PublishResult>;
  backup(): Promise<BackupResult>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  test(options?: TestOptions): Promise<TestResult>;
  restore(backupId: string, options?: RestoreOptions): Promise<RestoreResult>;
}