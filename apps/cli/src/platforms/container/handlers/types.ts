import { 
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  ProvisionHandlerContext as CoreProvisionHandlerContext,
  PublishHandlerContext as CorePublishHandlerContext,
  UpdateHandlerContext as CoreUpdateHandlerContext,
  StopHandlerContext as CoreStopHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  ProvisionHandlerResult,
  PublishHandlerResult,
  UpdateHandlerResult,
  StopHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  ProvisionHandler as CoreProvisionHandler,
  PublishHandler as CorePublishHandler,
  UpdateHandler as CoreUpdateHandler,
  StopHandler as CoreStopHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { ContainerPlatform } from '../platform.js';

/**
 * Container-specific check handler context
 */
export interface ContainerCheckHandlerContext extends CoreCheckHandlerContext<ContainerPlatform> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Container-specific start handler context
 */
export interface ContainerStartHandlerContext extends CoreStartHandlerContext<ContainerPlatform> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Container-specific provision handler context
 */
export interface ContainerProvisionHandlerContext extends CoreProvisionHandlerContext<ContainerPlatform> {
  runtime: 'docker' | 'podman';
}

/**
 * Container-specific publish handler context
 */
export interface ContainerPublishHandlerContext extends CorePublishHandlerContext<ContainerPlatform> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Container-specific update handler context
 */
export interface ContainerUpdateHandlerContext extends CoreUpdateHandlerContext<ContainerPlatform> {
  runtime: 'docker' | 'podman';
  containerName: string;
}

/**
 * Container-specific stop handler context
 */
export interface ContainerStopHandlerContext extends CoreStopHandlerContext<ContainerPlatform> {
  runtime: 'docker' | 'podman';
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
 * Function signature for Container publish handlers
 */
export type PublishHandler = CorePublishHandler<ContainerPlatform, ContainerPublishHandlerContext>;

/**
 * Function signature for Container update handlers
 */
export type UpdateHandler = CoreUpdateHandler<ContainerPlatform, ContainerUpdateHandlerContext>;

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
  PublishHandlerResult,
  UpdateHandlerResult,
  StopHandlerResult
};

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<ContainerPlatform> | CoreStartHandlerContext<ContainerPlatform> | CoreProvisionHandlerContext<ContainerPlatform> | CorePublishHandlerContext<ContainerPlatform> | CoreUpdateHandlerContext<ContainerPlatform> | CoreStopHandlerContext<ContainerPlatform>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult | PublishHandlerResult | UpdateHandlerResult | StopHandlerResult> = CoreHandlerDescriptor<ContainerPlatform, TContext, TResult>;