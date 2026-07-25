/**
 * Platform Strategy exports and factory
 */

export { Platform } from '../core/platform.js';
export type { PlatformType } from '../core/platform.js';


export { PosixPlatform } from './posix/platform.js';
export { ContainerPlatform } from './container/platform.js';
export { ExternalPlatform } from './external/platform.js';
export { MockPlatform } from './mock/platform.js';

import { Platform } from '../core/platform.js';
import { PlatformType } from '@semiont/core';
import { PosixPlatform } from './posix/platform.js';
import { ContainerPlatform } from './container/platform.js';
import { ExternalPlatform } from './external/platform.js';
import { MockPlatform } from './mock/platform.js';

/**
 * Factory for creating platform strategy instances.
 */
export class PlatformFactory {
  private static instances = new Map<PlatformType, Platform>();

  /**
   * Get a platform strategy instance (singleton per type)
   */
  static async getPlatform(type: PlatformType): Promise<Platform> {
    if (!this.instances.has(type)) {
      this.instances.set(type, await this.createPlatform(type));
    }
    return this.instances.get(type)!;
  }

  /**
   * Create a new platform strategy instance
   */
  private static async createPlatform(type: PlatformType): Promise<Platform> {
    switch (type) {
      case 'posix':
        return new PosixPlatform();
      case 'container':
        return new ContainerPlatform();
      case 'external':
        return new ExternalPlatform();
      case 'mock' as any:
        return new MockPlatform();
      default:
        throw new Error(`Unknown platform type: ${type}`);
    }
  }
}