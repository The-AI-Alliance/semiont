import { 
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  ProvisionHandlerContext as CoreProvisionHandlerContext,
  StopHandlerContext as CoreStopHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  StopHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  ProvisionHandler as CoreProvisionHandler,
  StopHandler as CoreStopHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { ContainerPlatform } from '../platform.js';

/**
 * Supported container runtimes
 */
export type ContainerRuntime = 'container' | 'docker' | 'podman';

/**
 * Container-specific check handler context
 */
export interface ContainerCheckHandlerContext extends CoreCheckHandlerContext<ContainerPlatform> {
  runtime: ContainerRuntime;
  containerName: string;
}

/**
 * Container-specific start handler context
 */
export interface ContainerStartHandlerContext extends CoreStartHandlerContext<ContainerPlatform> {
  runtime: ContainerRuntime;
  containerName: string;
}

/**
 * Container-specific provision handler context
 */
export interface ContainerProvisionHandlerContext extends CoreProvisionHandlerContext<ContainerPlatform> {
  runtime: ContainerRuntime;
  containerName: string;
}


/**
 * Container-specific stop handler context
 */
export interface ContainerStopHandlerContext extends CoreStopHandlerContext<ContainerPlatform> {
  runtime: ContainerRuntime;
  containerName: string;
}

/**
 * Function signature for Container check handlers
 */
export type CheckHandler = CoreCheckHandler<ContainerPlatform, ContainerCheckHandlerContext>;

/**
 * Function signature for Container start handlers
 */
export type StartHandler = CoreStartHandler<ContainerPlatform, ContainerStartHandlerContext>;

/**
 * Function signature for Container provision handlers
 */
export type ProvisionHandler = CoreProvisionHandler<ContainerPlatform, ContainerProvisionHandlerContext>;


/**
 * Function signature for Container stop handlers
 */
export type StopHandler = CoreStopHandler<ContainerPlatform, ContainerStopHandlerContext>;

/**
 * Re-export result types for convenience
 */
export type { 
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  StopHandlerResult
};

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<ContainerPlatform> | CoreStartHandlerContext<ContainerPlatform> | CoreProvisionHandlerContext<ContainerPlatform> | CoreStopHandlerContext<ContainerPlatform>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult | StopHandlerResult> = CoreHandlerDescriptor<ContainerPlatform, TContext, TResult>;