/**
 * Platform-specific Resource Types
 * 
 * Defines the resource identifiers and metadata that each platform
 * produces during operations. These are the concrete outputs that
 * get persisted in state for later reference.
 */

import type { Platform } from '../platforms/platform-resolver.js';

/**
 * Process platform resources - for services running as OS processes
 */
export interface ProcessResources {
  pid?: number;
  port?: number;
  path?: string;              // File system path (for filesystem services)
  workingDirectory?: string;
  command?: string;
  logFile?: string;
}

/**
 * Container platform resources - for services running in Docker/Podman
 */
export interface ContainerResources {
  id?: string;                // Short container ID
  containerId: string;        // Full container ID
  containerName?: string;
  image?: string;             // Full image name with tag
  imageName?: string;
  imageTag?: string;
  networkId?: string;
  networkName?: string;
  volumeId?: string;          // Volume ID for persistent storage
  ports?: Record<string, string>;  // host:container port mapping
  volumes?: Array<{
    host: string;
    container: string;
    mode: 'ro' | 'rw';
  }>;
}

/**
 * AWS platform resources - for services running on AWS infrastructure
 */
export interface AWSResources {
  // Core identifiers
  arn?: string;
  id?: string;                // Generic resource ID
  name?: string;              // Resource name
  
  // Service-specific
  taskArn?: string;          // ECS
  taskDefinitionArn?: string;
  clusterId?: string;         // ECS cluster ID
  clusterArn?: string;
  serviceArn?: string;
  instanceId?: string;        // EC2
  functionArn?: string;       // Lambda
  bucketName?: string;        // S3
  distributionId?: string;    // CloudFront
  databaseId?: string;        // RDS
  volumeId?: string;          // EBS/EFS volume ID
  networkId?: string;         // VPC/subnet ID
  
  // Common metadata
  region: string;
  accountId?: string;
  consoleUrl?: string;
  tags?: Record<string, string>;
}

/**
 * External platform resources - for externally managed services
 */
export interface ExternalResources {
  endpoint?: string;
  host?: string;
  port?: number;
  protocol?: string;
  path?: string;
  documentation?: string;
  provider?: string;
  apiKey?: string;  // Reference to where key is stored, not the key itself
}

/**
 * Mock platform resources - for testing
 */
export interface MockResources {
  mockId: string;
  mockPid?: number;
  mockPort?: number;
  mockEndpoint?: string;
}

/**
 * Discriminated union of all platform resources
 * This ensures type safety when working with platform-specific resources
 */
export type PlatformResources = 
  | { platform: 'process'; data: ProcessResources }
  | { platform: 'container'; data: ContainerResources }
  | { platform: 'aws'; data: AWSResources }
  | { platform: 'external'; data: ExternalResources }
  | { platform: 'mock'; data: MockResources };

/**
 * Type guard to check if resources match a specific platform
 */
export function isPlatformResources<P extends Platform>(
  resources: PlatformResources | undefined,
  platform: P
): resources is Extract<PlatformResources, { platform: P }> {
  return resources?.platform === platform;
}

/**
 * Helper to create platform resources with proper typing
 */
export function createPlatformResources<P extends Platform>(
  platform: P,
  data: P extends 'process' ? ProcessResources :
        P extends 'container' ? ContainerResources :
        P extends 'aws' ? AWSResources :
        P extends 'external' ? ExternalResources :
        P extends 'mock' ? MockResources :
        never
): PlatformResources {
  return { platform, data } as PlatformResources;
}