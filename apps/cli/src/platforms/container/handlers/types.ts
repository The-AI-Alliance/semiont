import { 
  BaseHandlerContext,
  HandlerResult,
  CheckHandlerResult as CoreCheckHandlerResult,
  StartHandlerResult as CoreStartHandlerResult,
  HandlerDescriptor as CoreHandlerDescriptor 
} from '../../../core/handlers/types.js';
import type { ContainerPlatformStrategy } from '../platform.js';

/**
 * Context provided to all Container check handlers
 */
export interface CheckHandlerContext extends BaseHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Context provided to all Container start handlers
 */
export interface StartHandlerContext extends BaseHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Result returned by check handlers
 * Extends the core CheckHandlerResult
 */
export interface CheckHandlerResult extends CoreCheckHandlerResult {
  // Container-specific additions can go here if needed
}

/**
 * Result returned by start handlers
 * Extends the core StartHandlerResult
 */
export interface StartHandlerResult extends CoreStartHandlerResult {
  // Container-specific additions can go here if needed
}

/**
 * Function signature for check handlers
 */
export type CheckHandler = (context: CheckHandlerContext) => Promise<CheckHandlerResult>;

/**
 * Function signature for start handlers
 */
export type StartHandler = (context: StartHandlerContext) => Promise<StartHandlerResult>;

/**
 * Context provided to Container provision handlers
 */
export interface ProvisionHandlerContext extends BaseHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
}

/**
 * Result returned by provision handlers
 */
export interface ProvisionHandlerResult extends HandlerResult {
  dependencies?: string[];
  resources?: any;
  metadata?: Record<string, any>;
}

/**
 * Function signature for provision handlers
 */
export type ProvisionHandler = (context: ProvisionHandlerContext) => Promise<ProvisionHandlerResult>;

/**
 * Context provided to Container publish handlers
 */
export interface PublishHandlerContext extends BaseHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Result returned by publish handlers
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
 * Function signature for publish handlers
 */
export type PublishHandler = (context: PublishHandlerContext) => Promise<PublishHandlerResult>;

/**
 * Context provided to Container update handlers
 */
export interface UpdateHandlerContext extends BaseHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Result returned by update handlers
 */
export interface UpdateHandlerResult extends HandlerResult {
  previousVersion?: string;
  newVersion?: string;
  strategy?: 'rolling' | 'restart' | 'recreate' | 'blue-green' | 'none';
  downtime?: number;
  metadata?: Record<string, any>;
}

/**
 * Function signature for update handlers
 */
export type UpdateHandler = (context: UpdateHandlerContext) => Promise<UpdateHandlerResult>;

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends BaseHandlerContext<any>, TResult extends HandlerResult> = CoreHandlerDescriptor<TContext, TResult>;