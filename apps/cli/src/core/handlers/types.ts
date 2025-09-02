import { Service } from '../../services/types.js';
import { PlatformResources } from '../../platforms/platform-resources.js';

/**
 * Core handler types that all platform handlers must implement
 */

/**
 * Base context provided to all handlers
 */
export interface BaseHandlerContext<TPlatform = string> {
  service: Service;
  platform: TPlatform;
  options: Record<string, any>;  // Command-specific options passed through
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
  status: 'running' | 'stopped' | 'unknown' | 'unhealthy';
  health?: {
    healthy: boolean;
    details: Record<string, any>;
  };
  platformResources?: PlatformResources;
  metadata: Record<string, any>;
  logs?: {
    recent: string[];
    errors: string[];
  };
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
  command: string;  // 'start', 'update', etc. - handler declares its command
  platform: string; // 'aws', 'container', etc. - handler declares its platform
  serviceType: string;  // 'lambda', 'ecs-fargate', etc.
  handler: Handler<TContext, TResult>;
  requiresDiscovery?: boolean;  // Whether this handler needs resource discovery
  expectedOptions?: string[];  // Options that this handler expects in context
}