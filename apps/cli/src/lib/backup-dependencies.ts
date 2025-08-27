/**
 * Dependency interfaces for backup command
 * This allows for easy testing without mocking
 */

import { ServicePlatformInfo } from './platform-resolver.js';
import { RDSClient } from '@aws-sdk/client-rds';
import * as fs from 'fs/promises';
import { validateServiceSelector, resolveServiceSelector } from './services.js';
import { resolveServiceDeployments } from './platform-resolver.js';
import { execInContainer } from './container-runtime.js';

export interface ServiceResolver {
  validate(selector: string, capability: string, env?: string): Promise<void>;
  resolve(selector: string, capability: string, env?: string): Promise<string[]>;
}

export interface DeploymentResolver {
  resolve(services: string[], environment: string): ServicePlatformInfo[];
}

export interface ContainerExecutor {
  exec(container: string, command: string[], options?: any): Promise<boolean>;
}

export interface AWSClients {
  createRDSClient(region: string): RDSClient;
}

export interface FileSystem {
  mkdir(path: string, options?: any): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string, encoding?: any): Promise<Buffer | string>;
}

export interface BackupDependencies {
  services: ServiceResolver;
  deployments: DeploymentResolver;
  container: ContainerExecutor;
  aws: AWSClients;
  fs: FileSystem;
}

/**
 * Create default production dependencies
 */
export function createProductionDependencies(): BackupDependencies {
  return {
    services: {
      validate: validateServiceSelector,
      resolve: resolveServiceSelector
    },
    deployments: {
      resolve: resolveServiceDeployments
    },
    container: {
      exec: execInContainer
    },
    aws: {
      createRDSClient: (region) => new RDSClient({ region })
    },
    fs: {
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile
    }
  };
}