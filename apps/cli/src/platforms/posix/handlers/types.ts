import {
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  ProvisionHandlerContext as CoreProvisionHandlerContext,
  PublishHandlerContext as CorePublishHandlerContext,
  StopHandlerContext as CoreStopHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  PublishHandlerResult,
  StopHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  ProvisionHandler as CoreProvisionHandler,
  PublishHandler as CorePublishHandler,
  StopHandler as CoreStopHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { PosixPlatform } from '../platform.js';
import type { ServiceState } from '../../../core/state-manager.js';

/**
 * POSIX-specific check handler context
 */
export interface PosixCheckHandlerContext extends CoreCheckHandlerContext<PosixPlatform> {
  savedState?: ServiceState;
}

/**
 * POSIX-specific start handler context
 */
export interface PosixStartHandlerContext extends CoreStartHandlerContext<PosixPlatform> {
  savedState?: ServiceState;
}

/**
 * POSIX-specific provision handler context
 */
export interface PosixProvisionHandlerContext extends CoreProvisionHandlerContext<PosixPlatform> {
  savedState?: ServiceState;
}

/**
 * POSIX-specific publish handler context
 */
export interface PosixPublishHandlerContext extends CorePublishHandlerContext<PosixPlatform> {
  savedState?: ServiceState;
}

/**
 * POSIX-specific stop handler context
 */
export interface PosixStopHandlerContext extends CoreStopHandlerContext<PosixPlatform> {
  savedState?: ServiceState;
}

/**
 * Function signature for POSIX check handlers
 */
export type CheckHandler = CoreCheckHandler<PosixPlatform, PosixCheckHandlerContext>;

/**
 * Function signature for POSIX start handlers
 */
export type StartHandler = CoreStartHandler<PosixPlatform, PosixStartHandlerContext>;

/**
 * Function signature for POSIX provision handlers
 */
export type ProvisionHandler = CoreProvisionHandler<PosixPlatform, PosixProvisionHandlerContext>;

/**
 * Function signature for POSIX publish handlers
 */
export type PublishHandler = CorePublishHandler<PosixPlatform, PosixPublishHandlerContext>;

/**
 * Function signature for POSIX stop handlers
 */
export type StopHandler = CoreStopHandler<PosixPlatform, PosixStopHandlerContext>;

/**
 * Re-export result types for convenience
 */
export type {
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  PublishHandlerResult,
  StopHandlerResult
};

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<PosixPlatform> | CoreStartHandlerContext<PosixPlatform> | CoreProvisionHandlerContext<PosixPlatform> | CorePublishHandlerContext<PosixPlatform> | CoreStopHandlerContext<PosixPlatform>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult | PublishHandlerResult | StopHandlerResult> = CoreHandlerDescriptor<PosixPlatform, TContext, TResult>;