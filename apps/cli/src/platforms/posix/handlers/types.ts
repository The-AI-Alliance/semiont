import { 
  BaseHandlerContext,
  HandlerResult,
  CheckHandlerResult as CoreCheckHandlerResult,
  StartHandlerResult as CoreStartHandlerResult,
  HandlerDescriptor as CoreHandlerDescriptor 
} from '../../../core/handlers/types.js';
import type { PosixPlatformStrategy } from '../platform.js';
import type { ServiceState } from '../../../core/state-manager.js';

/**
 * Context provided to all POSIX check handlers
 */
export interface CheckHandlerContext extends BaseHandlerContext<PosixPlatformStrategy> {
  savedState?: ServiceState;
}

/**
 * Context provided to all POSIX start handlers
 */
export interface StartHandlerContext extends BaseHandlerContext<PosixPlatformStrategy> {
  savedState?: ServiceState;
}

/**
 * Result returned by check handlers
 * Extends the core CheckHandlerResult
 */
export interface CheckHandlerResult extends CoreCheckHandlerResult {
  // POSIX-specific additions can go here if needed
}

/**
 * Result returned by start handlers
 * Extends the core StartHandlerResult
 */
export interface StartHandlerResult extends CoreStartHandlerResult {
  // POSIX-specific additions can go here if needed
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