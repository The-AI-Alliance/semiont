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
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends BaseHandlerContext<any>, TResult extends HandlerResult> = CoreHandlerDescriptor<TContext, TResult>;