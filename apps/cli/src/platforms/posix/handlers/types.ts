import { 
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  ProvisionHandlerContext as CoreProvisionHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  ProvisionHandler as CoreProvisionHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { PosixPlatformStrategy } from '../platform.js';
import type { ServiceState } from '../../../core/state-manager.js';

/**
 * POSIX-specific check handler context
 */
export interface PosixCheckHandlerContext extends CoreCheckHandlerContext<PosixPlatformStrategy> {
  savedState?: ServiceState;
}

/**
 * POSIX-specific start handler context
 */
export interface PosixStartHandlerContext extends CoreStartHandlerContext<PosixPlatformStrategy> {
  savedState?: ServiceState;
}

/**
 * POSIX-specific provision handler context
 */
export interface PosixProvisionHandlerContext extends CoreProvisionHandlerContext<PosixPlatformStrategy> {
  savedState?: ServiceState;
}

/**
 * Function signature for POSIX check handlers
 */
export type CheckHandler = CoreCheckHandler<PosixPlatformStrategy, PosixCheckHandlerContext>;

/**
 * Function signature for POSIX start handlers
 */
export type StartHandler = CoreStartHandler<PosixPlatformStrategy, PosixStartHandlerContext>;

/**
 * Function signature for POSIX provision handlers
 */
export type ProvisionHandler = CoreProvisionHandler<PosixPlatformStrategy, PosixProvisionHandlerContext>;

/**
 * Re-export result types for convenience
 */
export type { 
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult
};

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<PosixPlatformStrategy> | CoreStartHandlerContext<PosixPlatformStrategy> | CoreProvisionHandlerContext<PosixPlatformStrategy>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult> = CoreHandlerDescriptor<PosixPlatformStrategy, TContext, TResult>;