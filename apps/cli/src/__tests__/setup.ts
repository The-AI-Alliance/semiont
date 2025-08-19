/**
 * Test setup utilities for Semiont CLI tests
 * 
 * Provides helpers for creating properly initialized test environments
 * with semiont.json and environment configs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initCommand from '../commands/init.js';
const init = initCommand.handler;

/**
 * Creates a temporary test directory with initialized Semiont project
 * @param prefix - Prefix for the temp directory name
 * @param projectName - Optional project name for init
 * @returns Path to the created test directory
 */
export async function createTestEnvironment(
  prefix: string = 'semiont-test',
  projectName: string = 'test-project'
): Promise<string> {
  // Create temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  
  // Save current directory
  const originalCwd = process.cwd();
  
  try {
    // Change to temp directory for init
    process.chdir(tmpDir);
    
    // Initialize Semiont project using the actual init command
    await init([], {
      name: projectName,
      directory: tmpDir,
      force: false,
      environments: ['local', 'test', 'staging', 'production', 'remote'],
      environment: 'local',  // Required by BaseCommandOptions
      output: 'summary',
      quiet: true,  // Suppress output during test setup
      verbose: false,
      dryRun: false
    });
    
  } finally {
    // Restore original directory
    process.chdir(originalCwd);
  }
  
  return tmpDir;
}

/**
 * Creates a test environment config with all required services
 * @param envName - Name of the environment
 * @returns Environment configuration object
 */
export function createTestConfig(envName: string = 'test'): any {
  const config: any = {
    _comment: `Test environment: ${envName}`,
    deployment: {
      default: 'mock'
    },
    env: {
      NODE_ENV: 'test'
    },
    services: {
      frontend: {
        command: 'npm test',
        port: 3000
      },
      backend: {
        command: 'npm test',
        port: 3001
      },
      database: {
        deployment: {
          type: 'mock'
        },
        port: 5432,
        user: 'postgres',
        password: 'testpass'
      },
      filesystem: {
        deployment: {
          type: 'mock'
        },
        path: './test-data'
      }
    }
  };
  
  // Add AWS config for production and staging environments
  if (envName === 'production' || envName === 'staging') {
    config.aws = {
      region: 'us-east-1',
      accountId: '123456789012'
    };
    config.deployment.default = 'aws';
  }
  
  return config;
}

/**
 * Creates a test semiont.json configuration
 * @param projectName - Name of the project
 * @returns Semiont configuration object
 */
export function createTestSemiontJson(projectName: string = 'test-project'): any {
  return {
    version: '1.0',
    project: projectName,
    site: {
      siteName: projectName,
      domain: `${projectName}.test.com`,
      adminEmail: 'admin@test.com',
      supportEmail: 'support@test.com',
      oauthAllowedDomains: ['test.com']
    },
    defaults: {
      region: 'us-east-1',
      deployment: {
        type: 'container'
      },
      services: {
        frontend: {
          port: 3000
        },
        backend: {
          port: 3001
        },
        database: {
          port: 5432,
          user: 'postgres'
        }
      }
    }
  };
}

/**
 * Writes test configuration files to a directory
 * @param dir - Directory to write configs to
 * @param environments - List of environments to create configs for
 */
export function writeTestConfigs(
  dir: string,
  environments: string[] = ['local', 'test', 'staging', 'production']
): void {
  // Write semiont.json
  const semiontJson = createTestSemiontJson(path.basename(dir));
  fs.writeFileSync(
    path.join(dir, 'semiont.json'),
    JSON.stringify(semiontJson, null, 2)
  );
  
  // Create config/environments directory
  const envDir = path.join(dir, 'config', 'environments');
  fs.mkdirSync(envDir, { recursive: true });
  
  // Write environment configs
  for (const env of environments) {
    const config = createTestConfig(env);
    fs.writeFileSync(
      path.join(envDir, `${env}.json`),
      JSON.stringify(config, null, 2)
    );
  }
}

/**
 * Cleans up a test directory
 * @param dir - Directory to clean up
 */
export function cleanupTestEnvironment(dir: string): void {
  if (dir.startsWith(os.tmpdir())) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Creates a mock service configuration
 * @param serviceName - Name of the service
 * @param overrides - Optional overrides for the service config
 */
export function createMockService(
  serviceName: string,
  overrides: any = {}
): any {
  const defaults: Record<string, any> = {
    frontend: {
      command: 'npm test',
      port: 3000
    },
    backend: {
      command: 'npm test',
      port: 3001
    },
    database: {
      deployment: { type: 'mock' },
      port: 5432,
      user: 'postgres',
      password: 'testpass'
    },
    filesystem: {
      deployment: { type: 'mock' },
      path: './test-data'
    }
  };
  
  return {
    ...defaults[serviceName] || {},
    ...overrides
  };
}

/**
 * Creates a complete test environment configuration in memory
 * without writing to disk
 */
export function createInMemoryTestEnvironment(): {
  semiontJson: any;
  environments: Record<string, any>;
} {
  return {
    semiontJson: createTestSemiontJson(),
    environments: {
      local: createTestConfig('local'),
      test: createTestConfig('test'),
      staging: createTestConfig('staging'),
      production: createTestConfig('production')
    }
  };
}

/**
 * Mocks the deployment resolver to return test configurations
 * This is useful when testing without actual file system operations
 */
export function mockDeploymentResolver(testDir: string): void {
  // This would typically involve mocking the deployment-resolver module
  // For now, we ensure test configs exist on disk
  if (!fs.existsSync(path.join(testDir, 'semiont.json'))) {
    writeTestConfigs(testDir);
  }
}