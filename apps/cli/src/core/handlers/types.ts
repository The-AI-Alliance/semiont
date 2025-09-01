import { Service } from '../../services/types.js';
import { CheckResult } from '../commands/check.js';
import { PlatformResources } from '../../platforms/platform-resources.js';
import { CorePlatformCommand } from '../command-types.js';

/**
 * Core handler types that all platform handlers must implement
 */

/**
 * Base context provided to all handlers
 */
export interface BaseHandlerContext<TPlatform = string> {
  service: Service;
  platform: TPlatform;
}

/**
 * Result that handlers must return
 */
export interface HandlerResult {
  success: boolean;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Check handler specific types
 */
export interface CheckHandlerResult extends HandlerResult {
  status: CheckResult['status'];
  health?: CheckResult['health'];
  platformResources?: PlatformResources;
  metadata: Record<string, any>;
  logs?: CheckResult['logs'];
}

/**
 * Start handler specific types
 */
export interface StartHandlerResult extends HandlerResult {
  endpoint?: string;
  resources?: PlatformResources;
  metadata?: Record<string, any>;
}

/**
 * Generic handler function signature
 */
export type Handler<TContext extends BaseHandlerContext, TResult extends HandlerResult> = 
  (context: TContext) => Promise<TResult>;

/**
 * Check handler function signature
 */
export type CheckHandler<TContext extends BaseHandlerContext> = 
  Handler<TContext, CheckHandlerResult>;

/**
 * Start handler function signature
 */
export type StartHandler<TContext extends BaseHandlerContext> = 
  Handler<TContext, StartHandlerResult>;

/**
 * Handler descriptor that explicitly declares what command and service type it handles
 */
export interface HandlerDescriptor<TContext extends BaseHandlerContext, TResult extends HandlerResult> {
  command: CorePlatformCommand;
  serviceType: string;  // 'lambda', 'ecs-fargate', etc.
  handler: Handler<TContext, TResult>;
  requiresDiscovery?: boolean;  // Whether this handler needs resource discovery
}