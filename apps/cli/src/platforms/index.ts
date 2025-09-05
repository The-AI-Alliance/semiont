/**
 * Platform Strategy exports and factory
 */

export { BasePlatformStrategy } from '../core/platform-strategy.js';
export type { PlatformStrategy } from '../core/platform-strategy.js';


export { PosixPlatformStrategy } from './posix/platform.js';
export { ContainerPlatformStrategy } from './container/platform.js';
export { AWSPlatformStrategy } from './aws/platform.js';
export { ExternalPlatformStrategy } from './external/platform.js';
export { MockPlatformStrategy } from './mock/platform.js';


import { PlatformStrategy } from '../core/platform-strategy.js';
import { Platform } from '../core/platform-resolver.js';
import { PosixPlatformStrategy } from './posix/platform.js';
import { ContainerPlatformStrategy } from './container/platform.js';
import { AWSPlatformStrategy } from './aws/platform.js';
import { ExternalPlatformStrategy } from './external/platform.js';
import { MockPlatformStrategy } from './mock/platform.js';

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
      case 'posix':
        return new PosixPlatformStrategy();
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