/**
 * Platform Strategy exports and factory
 */

export { Platform } from '../core/platform.js';
export type { PlatformType } from '../core/platform.js';


export { PosixPlatform } from './posix/platform.js';
export { ContainerPlatform } from './container/platform.js';
export { AWSPlatform } from './aws/platform.js';
export { ExternalPlatform } from './external/platform.js';
export { MockPlatform } from './mock/platform.js';


import { Platform } from '../core/platform.js';
import { PlatformType } from '../core/platform-resolver.js';
import { PosixPlatform } from './posix/platform.js';
import { ContainerPlatform } from './container/platform.js';
import { AWSPlatform } from './aws/platform.js';
import { ExternalPlatform } from './external/platform.js';
import { MockPlatform } from './mock/platform.js';

/**
 * Factory for creating platform strategy instances
 * Now uses the refactored strategies that work with requirements
 */
export class PlatformFactory {
  private static instances = new Map<PlatformType, Platform>();
  
  /**
   * Get a platform strategy instance (singleton per type)
   */
  static getPlatform(type: PlatformType): Platform {
    if (!this.instances.has(type)) {
      this.instances.set(type, this.createPlatform(type));
    }
    return this.instances.get(type)!;
  }
  
  /**
   * Create a new platform strategy instance
   */
  private static createPlatform(type: PlatformType): Platform {
    switch (type) {
      case 'posix':
        return new PosixPlatform();
      case 'container':
        return new ContainerPlatform();
      case 'aws':
        return new AWSPlatform();
      case 'external':
        return new ExternalPlatform();
      case 'mock':
        return new MockPlatform();
      default:
        throw new Error(`Unknown platform type: ${type}`);
    }
  }
}