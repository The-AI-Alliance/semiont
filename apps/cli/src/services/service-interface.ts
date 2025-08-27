/**
 * Core Service Interface
 * 
 * Defines the contract that all services must implement.
 * Each service (backend, frontend, database, etc.) implements this interface.
 */

import type { Platform } from '../lib/platform-resolver.js';
import type { StartResult } from './start-service.js';
import type { StopResult } from './stop-service.js';
import type { CheckResult } from './check-service.js';
import type { UpdateResult } from './update-service.js';
import type { ProvisionResult } from './provision-service.js';
import type { PublishResult } from './publish-service.js';
import type { BackupResult } from './backup-service.js';
import type { ExecResult, ExecOptions } from './exec-service.js';
import type { TestResult, TestOptions } from './test-service.js';
import type { RestoreResult, RestoreOptions } from './restore-service.js';

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