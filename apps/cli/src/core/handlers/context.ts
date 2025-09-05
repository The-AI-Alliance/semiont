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
  static buildBaseContext<TPlatform = any>(
    service: Service, 
    platform: TPlatform,
    options: Record<string, any> = {}
  ): BaseHandlerContext<TPlatform> {
    return {
      service,
      platform,
      options
    };
  }

  /**
   * Extend context with additional properties
   */
  static extend<TPlatform = any, T extends BaseHandlerContext<TPlatform> = BaseHandlerContext<TPlatform>>(
    base: BaseHandlerContext<TPlatform>,
    extensions: Omit<T, keyof BaseHandlerContext<TPlatform>>
  ): T {
    return {
      ...base,
      ...extensions
    } as T;
  }
}