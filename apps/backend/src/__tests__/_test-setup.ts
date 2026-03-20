/**
 * Test Environment Setup Utilities
 *
 * Creates a minimal EnvironmentConfig and MakeMeaningConfig in memory
 * for backend integration tests.
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EnvironmentConfig } from '@semiont/core';

export interface TestEnvironmentConfig {
  config: EnvironmentConfig;
  dataPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a test environment with:
 * - Temporary directory for event store data
 * - In-memory EnvironmentConfig (no filesystem config files)
 * - SEMIONT_ROOT and SEMIONT_ENV set in process.env
 *
 * @param envName - Optional environment name (defaults to 'unit')
 */
export async function setupTestEnvironment(envName?: string): Promise<TestEnvironmentConfig> {
  const environment = envName || process.env.SEMIONT_ENV || 'unit';

  const testDir = join(tmpdir(), `semiont-backend-test-${Date.now()}`);
  await fs.mkdir(testDir, { recursive: true });

  const dataPath = join(testDir, 'data');
  await fs.mkdir(dataPath, { recursive: true });

  process.env.SEMIONT_ROOT = testDir;
  process.env.SEMIONT_ENV = environment;

  const config: EnvironmentConfig = {
    name: environment,
    services: {
      backend: {
        platform: { type: 'posix' },
        port: 4000,
        publicURL: 'http://localhost:4000',
        corsOrigin: 'http://localhost:3000',
      },
      graph: {
        platform: { type: 'posix' },
        type: 'memory',
      },
    },
    _metadata: {
      environment,
      projectRoot: testDir,
    },
  };

  return {
    config,
    dataPath,
    cleanup: async () => {
      delete process.env.SEMIONT_ROOT;
      delete process.env.SEMIONT_ENV;
      await fs.rm(testDir, { recursive: true, force: true });
    },
  };
}
