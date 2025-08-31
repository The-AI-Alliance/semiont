import { Handler, HandlerResult, BaseHandlerContext, HandlerDescriptor } from './types.js';

/**
 * Handler Registry
 * 
 * Central registry for command and service handlers across all platforms
 */
export class HandlerRegistry {
  private static instance: HandlerRegistry;
  private handlers: Map<string, Map<string, HandlerDescriptor<any, any>>> = new Map();

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): HandlerRegistry {
    if (!HandlerRegistry.instance) {
      HandlerRegistry.instance = new HandlerRegistry();
    }
    return HandlerRegistry.instance;
  }

  /**
   * Register a handler using a descriptor
   * 
   * @param platform - Platform name (e.g., 'aws', 'posix')
   * @param descriptor - Handler descriptor containing command, serviceType, and handler
   */
  registerHandler<TContext extends BaseHandlerContext, TResult extends HandlerResult>(
    platform: string,
    descriptor: HandlerDescriptor<TContext, TResult>
  ): void {
    const key = `${descriptor.command}-${descriptor.serviceType}`;
    
    if (!this.handlers.has(platform)) {
      this.handlers.set(platform, new Map());
    }
    this.handlers.get(platform)!.set(key, descriptor);
  }

  /**
   * Register multiple handlers using descriptors
   * 
   * @param platform - Platform name (e.g., 'aws', 'posix')
   * @param descriptors - Array of handler descriptors
   */
  registerHandlers(
    platform: string,
    descriptors: HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[]
  ): void {
    for (const descriptor of descriptors) {
      this.registerHandler(platform, descriptor);
    }
  }

  /**
   * Get a handler descriptor for a specific platform and operation
   * 
   * @param platform - Platform name
   * @param operation - Operation name
   * @returns Handler descriptor or undefined if not found
   */
  getDescriptor<TContext extends BaseHandlerContext, TResult extends HandlerResult>(
    platform: string,
    operation: string
  ): HandlerDescriptor<TContext, TResult> | undefined {
    return this.handlers.get(platform)?.get(operation) as HandlerDescriptor<TContext, TResult> | undefined;
  }

  /**
   * Get a handler function for a specific platform and operation
   * 
   * @param platform - Platform name
   * @param operation - Operation name
   * @returns Handler function or undefined if not found
   */
  get<TContext extends BaseHandlerContext, TResult extends HandlerResult>(
    platform: string,
    operation: string
  ): Handler<TContext, TResult> | undefined {
    const descriptor = this.getDescriptor<TContext, TResult>(platform, operation);
    return descriptor?.handler;
  }

  /**
   * Check if a handler exists
   */
  has(platform: string, operation: string): boolean {
    return this.handlers.get(platform)?.has(operation) ?? false;
  }

  /**
   * Clear all handlers (useful for testing)
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Get all registered platforms
   */
  getPlatforms(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get all operations for a platform
   */
  getOperations(platform: string): string[] {
    const platformHandlers = this.handlers.get(platform);
    return platformHandlers ? Array.from(platformHandlers.keys()) : [];
  }
}