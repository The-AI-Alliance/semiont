import { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

/**
 * Helper functions for exec tests
 */

export function createAWSDeployment(
  name: string,
  config: any = {}
): ServiceDeploymentInfo {
  return {
    name,
    deploymentType: 'aws',
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
): ServiceDeploymentInfo {
  return {
    name,
    deploymentType: 'container',
    config: config as any
  };
}

export function createProcessDeployment(
  name: string,
  config: any = {}
): ServiceDeploymentInfo {
  return {
    name,
    deploymentType: 'process',
    config: config as any
  };
}

export function createExternalDeployment(
  name: string,
  config: any = {}
): ServiceDeploymentInfo {
  return {
    name,
    deploymentType: 'external',
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