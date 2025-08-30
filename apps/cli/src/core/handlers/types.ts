import { Service } from '../../services/types.js';
import { CheckResult } from '../commands/check.js';
import { PlatformResources } from '../../platforms/platform-resources.js';

/**
 * Core handler types that all platform handlers must implement
 */

/**
 * Base context provided to all handlers
 */
export interface BaseHandlerContext {
  service: Service;
  platform: string;
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
 * Handler descriptor that explicitly declares what command and service type it handles
 */
export interface HandlerDescriptor<TContext extends BaseHandlerContext, TResult extends HandlerResult> {
  command: 'check' | 'start' | 'stop' | 'update' | 'provision' | 'publish';
  serviceType: string;  // 'lambda', 'ecs-fargate', etc.
  handler: Handler<TContext, TResult>;
}