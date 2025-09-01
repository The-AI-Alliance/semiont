import { 
  BaseHandlerContext,
  HandlerResult,
  CheckHandlerResult as CoreCheckHandlerResult,
  StartHandlerResult as CoreStartHandlerResult,
  HandlerDescriptor as CoreHandlerDescriptor 
} from '../../../core/handlers/types.js';
import type { AWSPlatformStrategy } from '../platform.js';

/**
 * Context provided to all AWS check handlers
 */
export interface CheckHandlerContext extends BaseHandlerContext<AWSPlatformStrategy> {
  cfnDiscoveredResources: any;
}

/**
 * Context provided to all AWS start handlers
 */
export interface StartHandlerContext extends BaseHandlerContext<AWSPlatformStrategy> {
  cfnDiscoveredResources?: any;
  accountId: string;
  region: string;
}

/**
 * Result returned by check handlers
 * Extends the core CheckHandlerResult
 */
export interface CheckHandlerResult extends CoreCheckHandlerResult {
  // AWS-specific additions can go here if needed
}

/**
 * Result returned by start handlers
 * Extends the core StartHandlerResult
 */
export interface StartHandlerResult extends CoreStartHandlerResult {
  // AWS-specific additions can go here if needed
}

/**
 * Function signature for check handlers
 */
export type CheckHandler = (context: CheckHandlerContext) => Promise<CheckHandlerResult>;

/**
 * Function signature for start handlers
 */
export type StartHandler = (context: StartHandlerContext) => Promise<StartHandlerResult>;

/**
 * Re-export HandlerDescriptor for convenience
 */
export type HandlerDescriptor<TContext extends BaseHandlerContext<any>, TResult extends HandlerResult> = CoreHandlerDescriptor<TContext, TResult>;

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