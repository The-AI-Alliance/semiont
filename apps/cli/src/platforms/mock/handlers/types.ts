import { 
  CheckHandlerContext as CoreCheckHandlerContext,
  StartHandlerContext as CoreStartHandlerContext,
  CheckHandlerResult,
  StartHandlerResult,
  CheckHandler as CoreCheckHandler,
  StartHandler as CoreStartHandler,
  HandlerDescriptor as CoreHandlerDescriptor
} from '../../../core/handlers/types.js';
import type { MockPlatform } from '../platform.js';

/**
 * Mock-specific check handler context
 */
export interface MockCheckHandlerContext extends CoreCheckHandlerContext<MockPlatform> {
  mockState: Map<string, any>;
}

/**
 * Mock-specific start handler context
 */
export interface MockStartHandlerContext extends CoreStartHandlerContext<MockPlatform> {
  mockState: Map<string, any>;
  mockData?: any;
}

/**
 * Function signature for Mock check handlers
 */
export type CheckHandler = CoreCheckHandler<MockPlatform, MockCheckHandlerContext>;

/**
 * Function signature for Mock start handlers
 */
export type StartHandler = CoreStartHandler<MockPlatform, MockStartHandlerContext>;

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
export type HandlerDescriptor<TContext extends CoreCheckHandlerContext<MockPlatform> | CoreStartHandlerContext<MockPlatform>, TResult extends CheckHandlerResult | StartHandlerResult> = CoreHandlerDescriptor<MockPlatform, TContext, TResult>;