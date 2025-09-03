import { 
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { ExternalPlatformStrategy } from '../platform.js';

/**
 * External-specific check handler context
 */
export interface ExternalCheckHandlerContext extends CoreCheckHandlerContext<ExternalPlatformStrategy> {
  endpoint?: string;
}

/**
 * External-specific start handler context
 */
export interface ExternalStartHandlerContext extends CoreStartHandlerContext<ExternalPlatformStrategy> {
  endpoint?: string;
}

/**
 * Function signature for External check handlers
 */
export type CheckHandler = CoreCheckHandler<ExternalPlatformStrategy, ExternalCheckHandlerContext>;

/**
 * Function signature for External start handlers
 */
export type StartHandler = CoreStartHandler<ExternalPlatformStrategy, ExternalStartHandlerContext>;

/**
 * Re-export result types for convenience
 */
export type { 
  CheckHandlerResult,
  StartHandlerResult
};

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<ExternalPlatformStrategy> | CoreStartHandlerContext<ExternalPlatformStrategy>, TResult extends CheckHandlerResult | StartHandlerResult> = CoreHandlerDescriptor<ExternalPlatformStrategy, TContext, TResult>;