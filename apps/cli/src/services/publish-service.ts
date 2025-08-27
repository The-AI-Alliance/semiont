/**
 * Publish Service Types and Interfaces
 * 
 * Defines the publish operation for services - building and distributing
 * artifacts like Docker images, packages, or static files.
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of a publish operation
 */
export interface PublishResult {
  entity: ServiceName;
  platform: Platform;
  success: boolean;
  publishTime: Date;
  artifacts?: {
    // Published artifacts
    imageTag?: string;
    imageUrl?: string;
    packageName?: string;
    packageVersion?: string;
    bundleUrl?: string;
    staticSiteUrl?: string;
    // Registry/repository info
    registry?: string;
    repository?: string;
    branch?: string;
    commitSha?: string;
  };
  version?: {
    previous?: string;
    current?: string;
    tag?: string;
  };
  destinations?: {
    registry?: string;
    bucket?: string;
    cdn?: string;
    repository?: string;
  };
  rollback?: {
    supported: boolean;
    command?: string;
    artifactId?: string;
  };
  resources?: PlatformResources;  error?: string;
  metadata?: Record<string, any>;
}