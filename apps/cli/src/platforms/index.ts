/**
 * Platform Strategy exports and factory
 */

export { BasePlatformStrategy } from './platform-strategy.js';
export type { PlatformStrategy, ServiceContext } from './platform-strategy.js';

// Export refactored platform strategies
export { ProcessPlatformStrategyRefactored } from './process-platform-refactored.js';
export { ContainerPlatformStrategyRefactored } from './container-platform-refactored.js';
export { AWSPlatformStrategyRefactored } from './aws-platform-refactored.js';
export { ExternalPlatformStrategyRefactored } from './external-platform-refactored.js';
export { MockPlatformStrategy } from './mock-platform.js';

// Keep old exports for backward compatibility during migration
export { ProcessPlatformStrategy } from './process-platform.js';
export { ContainerPlatformStrategy } from './container-platform.js';
export { AWSPlatformStrategy } from './aws-platform.js';
export { ExternalPlatformStrategy } from './external-platform.js';

import { PlatformStrategy } from './platform-strategy.js';
import { ProcessPlatformStrategyRefactored } from './process-platform-refactored.js';
import { ContainerPlatformStrategyRefactored } from './container-platform-refactored.js';
import { AWSPlatformStrategyRefactored } from './aws-platform-refactored.js';
import { ExternalPlatformStrategyRefactored } from './external-platform-refactored.js';
import { MockPlatformStrategy } from './mock-platform.js';
import { Platform } from '../lib/platform-resolver.js';

/**
 * Factory for creating platform strategy instances
 * Now uses the refactored strategies that work with requirements
 */
export class PlatformFactory {
  private static instances = new Map<Platform, PlatformStrategy>();
  private static useRefactored = true; // Feature flag to switch between old and new
  
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
   * Uses refactored strategies that work with requirements pattern
   */
  private static createPlatform(type: Platform): PlatformStrategy {
    if (this.useRefactored) {
      switch (type) {
        case 'process':
          return new ProcessPlatformStrategyRefactored();
        case 'container':
          return new ContainerPlatformStrategyRefactored();
        case 'aws':
          return new AWSPlatformStrategyRefactored();
        case 'external':
          return new ExternalPlatformStrategyRefactored();
        case 'mock':
          return new MockPlatformStrategy(); // Already refactored
        default:
          throw new Error(`Unknown deployment type: ${type}`);
      }
    } else {
      // Old implementation for rollback if needed
      const { ProcessPlatformStrategy } = require('./process-platform.js');
      const { ContainerPlatformStrategy } = require('./container-platform.js');
      const { AWSPlatformStrategy } = require('./aws-platform.js');
      const { ExternalPlatformStrategy } = require('./external-platform.js');
      
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
          throw new Error(`Unknown deployment type: ${type}`);
      }
    }
  }
  
  /**
   * Toggle between old and new implementations for testing
   */
  static setUseRefactored(value: boolean): void {
    this.useRefactored = value;
    this.instances.clear(); // Clear cache to force recreation
  }
}