import { Service } from '../../services/types.js';
import { PlatformResources } from '../../platforms/platform-resources.js';

/**
 * Core handler types that all platform handlers must implement
 */

/**
 * Base context provided to all handlers
 * TPlatform is the platform strategy type (e.g., AWSPlatformStrategy)
 */
export interface BaseHandlerContext<TPlatform = any> {
  service: Service;
  platform: TPlatform;
  options: Record<string, any>;  // Command-specific options passed through
}

/**
 * Generic check handler context
 * Platform-specific contexts should extend this with additional fields
 */
export interface CheckHandlerContext<TPlatform = any> extends BaseHandlerContext<TPlatform> {
  // Platform-specific fields will be added in platform-specific types
}

/**
 * Generic start handler context
 * Platform-specific contexts should extend this with additional fields
 */
export interface StartHandlerContext<TPlatform = any> extends BaseHandlerContext<TPlatform> {
  // Platform-specific fields will be added in platform-specific types
}

/**
 * Generic provision handler context
 */
export interface ProvisionHandlerContext<TPlatform = any> extends BaseHandlerContext<TPlatform> {
  // Platform-specific fields will be added in platform-specific types
}

/**
 * Generic publish handler context
 */
export interface PublishHandlerContext<TPlatform = any> extends BaseHandlerContext<TPlatform> {
  // Platform-specific fields will be added in platform-specific types
}

/**
 * Generic update handler context
 */
export interface UpdateHandlerContext<TPlatform = any> extends BaseHandlerContext<TPlatform> {
  // Platform-specific fields will be added in platform-specific types
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
 * Check handler specific result
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
 * Start handler specific result
 */
export interface StartHandlerResult extends HandlerResult {
  startTime?: Date;
  endpoint?: string;
  resources?: PlatformResources;
  metadata?: Record<string, any>;
}

/**
 * Provision handler specific result
 */
export interface ProvisionHandlerResult extends HandlerResult {
  dependencies?: string[];
  resources?: PlatformResources;
  metadata?: Record<string, any>;
}

/**
 * Publish handler specific result
 */
export interface PublishHandlerResult extends HandlerResult {
  artifacts?: Record<string, any>;
  rollback?: {
    supported: boolean;
    command?: string;
  };
  registry?: {
    type: string;
    uri: string;
    tags: string[];
  };
  metadata?: Record<string, any>;
}

/**
 * Update handler specific result
 */
export interface UpdateHandlerResult extends HandlerResult {
  previousVersion?: string;
  newVersion?: string;
  strategy?: 'rolling' | 'restart' | 'recreate' | 'blue-green' | 'none';
  downtime?: number;
  metadata?: Record<string, any>;
}

/**
 * Generic handler function signature
 * TPlatform is the platform strategy type
 */
export type Handler<TPlatform, TContext extends BaseHandlerContext<TPlatform>, TResult extends HandlerResult> = 
  (context: TContext) => Promise<TResult>;

/**
 * Check handler function signature
 */
export type CheckHandler<TPlatform, TContext extends CheckHandlerContext<TPlatform> = CheckHandlerContext<TPlatform>> = 
  Handler<TPlatform, TContext, CheckHandlerResult>;

/**
 * Start handler function signature
 */
export type StartHandler<TPlatform, TContext extends StartHandlerContext<TPlatform> = StartHandlerContext<TPlatform>> = 
  Handler<TPlatform, TContext, StartHandlerResult>;

/**
 * Provision handler function signature
 */
export type ProvisionHandler<TPlatform, TContext extends ProvisionHandlerContext<TPlatform> = ProvisionHandlerContext<TPlatform>> = 
  Handler<TPlatform, TContext, ProvisionHandlerResult>;

/**
 * Publish handler function signature
 */
export type PublishHandler<TPlatform, TContext extends PublishHandlerContext<TPlatform> = PublishHandlerContext<TPlatform>> = 
  Handler<TPlatform, TContext, PublishHandlerResult>;

/**
 * Update handler function signature
 */
export type UpdateHandler<TPlatform, TContext extends UpdateHandlerContext<TPlatform> = UpdateHandlerContext<TPlatform>> = 
  Handler<TPlatform, TContext, UpdateHandlerResult>;

/**
 * Handler descriptor that explicitly declares what command and service type it handles
 * TPlatform is the platform strategy type
 */
export interface HandlerDescriptor<TPlatform, TContext extends BaseHandlerContext<TPlatform>, TResult extends HandlerResult> {
  command: string;  // 'start', 'update', etc. - handler declares its command
  platform: string; // 'aws', 'container', etc. - handler declares its platform
  serviceType: string;  // 'lambda', 'ecs-fargate', etc.
  handler: Handler<TPlatform, TContext, TResult>;
  requiresDiscovery?: boolean;  // Whether this handler needs resource discovery
  expectedOptions?: string[];  // Options that this handler expects in context
}