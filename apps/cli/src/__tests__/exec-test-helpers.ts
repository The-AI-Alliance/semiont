import { ServicePlatformInfo } from '../platforms/platform-resolver.js';

/**
 * Helper functions for exec tests
 */

export function createAWSDeployment(
  name: string,
  config: any = {}
): ServicePlatformInfo {
  return {
    name,
    platform: 'aws',
    config: {
      aws: {
        region: 'us-east-1',
        accountId: '123456789012'
      },
      ...config
    } as any
  };
}

export function createContainerDeployment(
  name: string,
  config: any = {}
): ServicePlatformInfo {
  return {
    name,
    platform: 'container',
    config: config as any
  };
}

export function createProcessDeployment(
  name: string,
  config: any = {}
): ServicePlatformInfo {
  return {
    name,
    platform: 'process',
    config: config as any
  };
}

export function createExternalDeployment(
  name: string,
  config: any = {}
): ServicePlatformInfo {
  return {
    name,
    platform: 'external',
    config: config as any
  };
}

export function createExecOptions(overrides: any = {}) {
  return {
    environment: 'test',
    command: '/bin/sh',
    interactive: true,
    verbose: false,
    dryRun: false,
    output: 'json' as const,
    ...overrides
  };
}