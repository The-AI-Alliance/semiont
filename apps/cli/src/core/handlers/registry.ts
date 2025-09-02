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
   * Handlers now self-declare their platform and command
   * 
   * @param descriptor - Handler descriptor containing platform, command, serviceType, and handler
   */
  registerHandler<TContext extends BaseHandlerContext, TResult extends HandlerResult>(
    descriptor: HandlerDescriptor<TContext, TResult>
  ): void {
    const platform = descriptor.platform;
    const key = `${descriptor.command}:${descriptor.serviceType}`;
    
    if (!this.handlers.has(platform)) {
      this.handlers.set(platform, new Map());
    }
    this.handlers.get(platform)!.set(key, descriptor);
  }

  /**
   * Register multiple handlers using descriptors
   * 
   * @param platform - Platform name (e.g., 'aws', 'posix') - for backward compatibility
   * @param descriptors - Array of handler descriptors
   */
  registerHandlers(
    platform: string,
    descriptors: HandlerDescriptor<BaseHandlerContext<any>, HandlerResult>[]
  ): void {
    for (const descriptor of descriptors) {
      // Use descriptor's platform if available, otherwise use provided platform
      const descriptorWithPlatform = descriptor.platform 
        ? descriptor 
        : { ...descriptor, platform };
      this.registerHandler(descriptorWithPlatform);
    }
  }

  /**
   * Get a handler for a specific command, platform, and service type
   * 
   * @param command - Command name (e.g., 'start', 'update')
   * @param platform - Platform name (e.g., 'aws', 'posix')
   * @param serviceType - Service type (e.g., 'ecs', 'lambda')
   * @returns Handler descriptor or undefined if not found
   */
  getHandlerForCommand<TContext extends BaseHandlerContext<any>, TResult extends HandlerResult>(
    command: string,
    platform: string,
    serviceType: string
  ): HandlerDescriptor<TContext, TResult> | undefined {
    const key = `${command}:${serviceType}`;
    return this.handlers.get(platform)?.get(key) as HandlerDescriptor<TContext, TResult> | undefined;
  }

  /**
   * Get a handler descriptor for a specific platform and operation
   * For backward compatibility with old format
   * 
   * @param platform - Platform name
   * @param operation - Operation name (e.g., 'check-ecs' or 'check:ecs')
   * @returns Handler descriptor or undefined if not found
   */
  getDescriptor<TContext extends BaseHandlerContext, TResult extends HandlerResult>(
    platform: string,
    operation: string
  ): HandlerDescriptor<TContext, TResult> | undefined {
    // Try new format first (command:serviceType)
    let descriptor = this.handlers.get(platform)?.get(operation) as HandlerDescriptor<TContext, TResult> | undefined;
    
    // If not found and operation contains dash, try converting to new format
    if (!descriptor && operation.includes('-')) {
      const [command, ...serviceTypeParts] = operation.split('-');
      const serviceType = serviceTypeParts.join('-');
      const newKey = `${command}:${serviceType}`;
      descriptor = this.handlers.get(platform)?.get(newKey) as HandlerDescriptor<TContext, TResult> | undefined;
    }
    
    return descriptor;
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