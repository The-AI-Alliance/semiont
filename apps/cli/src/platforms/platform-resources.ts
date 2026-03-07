/**
 * Platform-specific Resource Types
 * 
 * Defines the resource identifiers and metadata that each platform
 * produces during operations. These are the concrete outputs that
 * get persisted in state for later reference.
 */

import type { PlatformType } from '@semiont/core';
import type { PosixResources } from './posix/types.js';
import type { ContainerResources } from './container/types.js';
import type { AWSResources } from './aws/types.js';
import type { ExternalResources } from './external/types.js';
import type { MockResources } from './mock/types.js';

// Re-export for use by platform implementations
export type { PosixResources, ContainerResources, AWSResources, ExternalResources, MockResources };


/**
 * Discriminated union of all platform resources
 * This ensures type safety when working with platform-specific resources
 */
export type PlatformResources = 
  | { platform: 'posix'; data: PosixResources }
  | { platform: 'container'; data: ContainerResources }
  | { platform: 'aws'; data: AWSResources }
  | { platform: 'external'; data: ExternalResources }
  | { platform: 'mock'; data: MockResources };

/**
 * Type guard to check if resources match a specific platform
 */
export function isPlatformResources<P extends PlatformType>(
  resources: PlatformResources | undefined,
  platform: P
): resources is Extract<PlatformResources, { platform: P }> {
  return resources?.platform === platform;
}

/**
 * Helper to create platform resources with proper typing
 */
export function createPlatformResources<P extends PlatformType>(
  platform: P,
  data: P extends 'posix' ? PosixResources :
        P extends 'container' ? ContainerResources :
        P extends 'aws' ? AWSResources :
        P extends 'external' ? ExternalResources :
        P extends 'mock' ? MockResources :
        never
): PlatformResources {
  return { platform, data } as PlatformResources;
}