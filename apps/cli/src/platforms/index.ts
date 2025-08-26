/**
 * Platform Strategy exports and factory
 */

export { BasePlatformStrategy } from './platform-strategy.js';
export type { PlatformStrategy, ServiceContext } from './platform-strategy.js';
export { ProcessPlatformStrategy } from './process-platform.js';
export { ContainerPlatformStrategy } from './container-platform.js';
export { AWSPlatformStrategy } from './aws-platform.js';
export { ExternalPlatformStrategy } from './external-platform.js';

import { PlatformStrategy } from './platform-strategy.js';
import { ProcessPlatformStrategy } from './process-platform.js';
import { ContainerPlatformStrategy } from './container-platform.js';
import { AWSPlatformStrategy } from './aws-platform.js';
import { ExternalPlatformStrategy } from './external-platform.js';
import { DeploymentType } from '../services/types.js';

/**
 * Factory for creating platform strategy instances
 */
export class PlatformFactory {
  private static instances = new Map<DeploymentType, PlatformStrategy>();
  
  /**
   * Get a platform strategy instance (singleton per type)
   */
  static getPlatform(type: DeploymentType): PlatformStrategy {
    if (!this.instances.has(type)) {
      this.instances.set(type, this.createPlatform(type));
    }
    return this.instances.get(type)!;
  }
  
  /**
   * Create a new platform strategy instance
   */
  private static createPlatform(type: DeploymentType): PlatformStrategy {
    switch (type) {
      case 'process':
        return new ProcessPlatformStrategy();
      case 'container':
        return new ContainerPlatformStrategy();
      case 'aws':
        return new AWSPlatformStrategy();
      case 'external':
        return new ExternalPlatformStrategy();
      default:
        throw new Error(`Unknown deployment type: ${type}`);
    }
  }
}