import { 
  BaseHandlerContext,
  HandlerResult,
  CheckHandlerResult as CoreCheckHandlerResult,
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
 * Result returned by check handlers
 * Extends the core CheckHandlerResult
 */
export interface CheckHandlerResult extends CoreCheckHandlerResult {
  // Container-specific additions can go here if needed
}

/**
 * Function signature for check handlers
 */
export type CheckHandler = (context: CheckHandlerContext) => Promise<CheckHandlerResult>;

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends BaseHandlerContext<any>, TResult extends HandlerResult> = CoreHandlerDescriptor<TContext, TResult>;