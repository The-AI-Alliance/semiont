import { 
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  ProvisionHandlerContext as CoreProvisionHandlerContext,
  PublishHandlerContext as CorePublishHandlerContext,
  UpdateHandlerContext as CoreUpdateHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  PublishHandlerResult,
  UpdateHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  ProvisionHandler as CoreProvisionHandler,
  PublishHandler as CorePublishHandler,
  UpdateHandler as CoreUpdateHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { ContainerPlatformStrategy } from '../platform.js';

/**
 * Container-specific check handler context
 */
export interface ContainerCheckHandlerContext extends CoreCheckHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Container-specific start handler context
 */
export interface ContainerStartHandlerContext extends CoreStartHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Container-specific provision handler context
 */
export interface ContainerProvisionHandlerContext extends CoreProvisionHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
}

/**
 * Container-specific publish handler context
 */
export interface ContainerPublishHandlerContext extends CorePublishHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Container-specific update handler context
 */
export interface ContainerUpdateHandlerContext extends CoreUpdateHandlerContext<ContainerPlatformStrategy> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Function signature for Container check handlers
 */
export type CheckHandler = CoreCheckHandler<ContainerPlatformStrategy, ContainerCheckHandlerContext>;

/**
 * Function signature for Container start handlers
 */
export type StartHandler = CoreStartHandler<ContainerPlatformStrategy, ContainerStartHandlerContext>;

/**
 * Function signature for Container provision handlers
 */
export type ProvisionHandler = CoreProvisionHandler<ContainerPlatformStrategy, ContainerProvisionHandlerContext>;

/**
 * Function signature for Container publish handlers
 */
export type PublishHandler = CorePublishHandler<ContainerPlatformStrategy, ContainerPublishHandlerContext>;

/**
 * Function signature for Container update handlers
 */
export type UpdateHandler = CoreUpdateHandler<ContainerPlatformStrategy, ContainerUpdateHandlerContext>;

/**
 * Re-export result types for convenience
 */
export type { 
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  PublishHandlerResult,
  UpdateHandlerResult
};

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<ContainerPlatformStrategy> | CoreStartHandlerContext<ContainerPlatformStrategy> | CoreProvisionHandlerContext<ContainerPlatformStrategy> | CorePublishHandlerContext<ContainerPlatformStrategy> | CoreUpdateHandlerContext<ContainerPlatformStrategy>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult | PublishHandlerResult | UpdateHandlerResult> = CoreHandlerDescriptor<ContainerPlatformStrategy, TContext, TResult>;