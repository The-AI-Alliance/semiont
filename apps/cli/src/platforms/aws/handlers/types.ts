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
import type { AWSPlatform } from '../platform.js';

/**
 * AWS-specific check handler context
 */
export interface AWSCheckHandlerContext extends CoreCheckHandlerContext<AWSPlatform> {
  cfnDiscoveredResources: any;
  region: string;
  accountId: string;
  resourceName: string;
  awsConfig?: {
    region: string;
    accountId: string;
    dataStack?: string;
    appStack?: string;
  };
}

/**
 * AWS-specific start handler context
 */
export interface AWSStartHandlerContext extends CoreStartHandlerContext<AWSPlatform> {
  cfnDiscoveredResources?: any;
  accountId: string;
  region: string;
}

/**
 * AWS-specific provision handler context
 */
export interface AWSProvisionHandlerContext extends CoreProvisionHandlerContext<AWSPlatform> {
  awsConfig: {
    region: string;
    accountId: string;
    dataStack?: string;
    appStack?: string;
  };
}

/**
 * AWS-specific publish handler context
 */
export interface AWSPublishHandlerContext extends CorePublishHandlerContext<AWSPlatform> {
  awsConfig: {
    region: string;
    accountId: string;
    dataStack?: string;
    appStack?: string;
  };
  resourceName: string;
}

/**
 * AWS-specific update handler context
 */
export interface AWSUpdateHandlerContext extends CoreUpdateHandlerContext<AWSPlatform> {
  cfnDiscoveredResources: any;
  region: string;
  accountId: string;
  resourceName: string;
}

/**
 * Function signature for AWS check handlers
 */
export type CheckHandler = CoreCheckHandler<AWSPlatform, AWSCheckHandlerContext>;

/**
 * Function signature for AWS start handlers
 */
export type StartHandler = CoreStartHandler<AWSPlatform, AWSStartHandlerContext>;

/**
 * Function signature for AWS provision handlers
 */
export type ProvisionHandler = CoreProvisionHandler<AWSPlatform, AWSProvisionHandlerContext>;

/**
 * Function signature for AWS publish handlers
 */
export type PublishHandler = CorePublishHandler<AWSPlatform, AWSPublishHandlerContext>;

/**
 * Function signature for AWS update handlers
 */
export type UpdateHandler = CoreUpdateHandler<AWSPlatform, AWSUpdateHandlerContext>;

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
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<AWSPlatform> | CoreStartHandlerContext<AWSPlatform> | CoreProvisionHandlerContext<AWSPlatform> | CorePublishHandlerContext<AWSPlatform> | CoreUpdateHandlerContext<AWSPlatform>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult | PublishHandlerResult | UpdateHandlerResult> = CoreHandlerDescriptor<AWSPlatform, TContext, TResult>;

/**
 * Registry of check handlers by service type
 */
export interface CheckHandlerRegistry {
  ecs: CheckHandler;
  rds: CheckHandler;
  efs: CheckHandler;
  lambda: CheckHandler;
  s3: CheckHandler;
  cloudfront: CheckHandler;
}