/**
 * Platform Strategy exports and factory
 */

export { BasePlatformStrategy } from './platform-strategy.js';
export type { PlatformStrategy, ServiceContext } from './platform-strategy.js';

// Export platform strategies
export { ProcessPlatformStrategy } from './process-platform.js';
export { ContainerPlatformStrategy } from './container-platform.js';
export { AWSPlatformStrategy } from './aws-platform.js';
export { ExternalPlatformStrategy } from './external-platform.js';
export { MockPlatformStrategy } from './mock-platform.js';

import { PlatformStrategy } from './platform-strategy.js';
import { ProcessPlatformStrategy } from './process-platform.js';
import { ContainerPlatformStrategy } from './container-platform.js';
import { AWSPlatformStrategy } from './aws-platform.js';
import { ExternalPlatformStrategy } from './external-platform.js';
import { MockPlatformStrategy } from './mock-platform.js';
import { Platform } from '../lib/platform-resolver.js';

/**
 * Factory for creating platform strategy instances
 * Now uses the refactored strategies that work with requirements
 */
export class PlatformFactory {
  private static instances = new Map<Platform, PlatformStrategy>();
  
  /**
   * Get a platform strategy instance (singleton per type)
   */
  static getPlatform(type: Platform): PlatformStrategy {
    if (!this.instances.has(type)) {
      this.instances.set(type, this.createPlatform(type));
    }
    return this.instances.get(type)!;
  }
  
  /**
   * Create a new platform strategy instance
   */
  private static createPlatform(type: Platform): PlatformStrategy {
    switch (type) {
      case 'process':
        return new ProcessPlatformStrategy();
      case 'container':
        return new ContainerPlatformStrategy();
      case 'aws':
        return new AWSPlatformStrategy();
      case 'external':
        return new ExternalPlatformStrategy();
      case 'mock':
        return new MockPlatformStrategy();
      default:
        throw new Error(`Unknown platform type: ${type}`);
    }
  }
}