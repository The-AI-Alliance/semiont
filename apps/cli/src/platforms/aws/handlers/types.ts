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
import type { AWSPlatformStrategy } from '../platform.js';

/**
 * AWS-specific check handler context
 */
export interface AWSCheckHandlerContext extends CoreCheckHandlerContext<AWSPlatformStrategy> {
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
export interface AWSStartHandlerContext extends CoreStartHandlerContext<AWSPlatformStrategy> {
  cfnDiscoveredResources?: any;
  accountId: string;
  region: string;
}

/**
 * AWS-specific provision handler context
 */
export interface AWSProvisionHandlerContext extends CoreProvisionHandlerContext<AWSPlatformStrategy> {
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
export interface AWSPublishHandlerContext extends CorePublishHandlerContext<AWSPlatformStrategy> {
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
export interface AWSUpdateHandlerContext extends CoreUpdateHandlerContext<AWSPlatformStrategy> {
  cfnDiscoveredResources: any;
  region: string;
  accountId: string;
  resourceName: string;
}

/**
 * Function signature for AWS check handlers
 */
export type CheckHandler = CoreCheckHandler<AWSPlatformStrategy, AWSCheckHandlerContext>;

/**
 * Function signature for AWS start handlers
 */
export type StartHandler = CoreStartHandler<AWSPlatformStrategy, AWSStartHandlerContext>;

/**
 * Function signature for AWS provision handlers
 */
export type ProvisionHandler = CoreProvisionHandler<AWSPlatformStrategy, AWSProvisionHandlerContext>;

/**
 * Function signature for AWS publish handlers
 */
export type PublishHandler = CorePublishHandler<AWSPlatformStrategy, AWSPublishHandlerContext>;

/**
 * Function signature for AWS update handlers
 */
export type UpdateHandler = CoreUpdateHandler<AWSPlatformStrategy, AWSUpdateHandlerContext>;

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
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<AWSPlatformStrategy> | CoreStartHandlerContext<AWSPlatformStrategy> | CoreProvisionHandlerContext<AWSPlatformStrategy> | CorePublishHandlerContext<AWSPlatformStrategy> | CoreUpdateHandlerContext<AWSPlatformStrategy>, TResult extends CheckHandlerResult | StartHandlerResult | ProvisionHandlerResult | PublishHandlerResult | UpdateHandlerResult> = CoreHandlerDescriptor<AWSPlatformStrategy, TContext, TResult>;

/**
 * Backward compatibility aliases for context types
 */
export type CheckHandlerContext = AWSCheckHandlerContext;
export type StartHandlerContext = AWSStartHandlerContext;
export type ProvisionHandlerContext = AWSProvisionHandlerContext;
export type PublishHandlerContext = AWSPublishHandlerContext;
export type UpdateHandlerContext = AWSUpdateHandlerContext;

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