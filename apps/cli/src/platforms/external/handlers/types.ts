import { 
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { ExternalPlatform } from '../platform.js';

/**
 * External-specific check handler context
 */
export interface ExternalCheckHandlerContext extends CoreCheckHandlerContext<ExternalPlatform> {
  endpoint?: string;
}

/**
 * External-specific start handler context
 */
export interface ExternalStartHandlerContext extends CoreStartHandlerContext<ExternalPlatform> {
  endpoint?: string;
}

/**
 * Function signature for External check handlers
 */
export type CheckHandler = CoreCheckHandler<ExternalPlatform, ExternalCheckHandlerContext>;

/**
 * Function signature for External start handlers
 */
export type StartHandler = CoreStartHandler<ExternalPlatform, ExternalStartHandlerContext>;

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
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<ExternalPlatform> | CoreStartHandlerContext<ExternalPlatform>, TResult extends CheckHandlerResult | StartHandlerResult> = CoreHandlerDescriptor<ExternalPlatform, TContext, TResult>;