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
 * External-specific provision handler context
 */
export interface ExternalProvisionHandlerContext extends CoreProvisionHandlerContext<ExternalPlatform> {
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
 * Function signature for External provision handlers
 */
export type ProvisionHandler = CoreProvisionHandler<ExternalPlatform, ExternalProvisionHandlerContext>;

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
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<ExternalPlatform> | CoreStartHandlerContext<ExternalPlatform> | CoreProvisionHandlerContext<ExternalPlatform>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult> = CoreHandlerDescriptor<ExternalPlatform, TContext, TResult>;