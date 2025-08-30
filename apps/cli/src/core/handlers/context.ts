import { Service } from '../../services/types.js';
import { BaseHandlerContext } from './types.js';

/**
 * Handler Context Builder
 * 
 * Builds context objects for handlers with common functionality
 */
export class HandlerContextBuilder {
  /**
   * Build base context that all handlers receive
   */
  static buildBaseContext(service: Service, platform: string): BaseHandlerContext {
    return {
      service,
      platform
    };
  }

  /**
   * Extend context with additional properties
   */
  static extend<T extends BaseHandlerContext>(
    base: BaseHandlerContext,
    extensions: Omit<T, keyof BaseHandlerContext>
  ): T {
    return {
      ...base,
      ...extensions
    } as T;
  }
}