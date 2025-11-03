/**
 * Test Environment Setup Utilities
 *
 * Creates proper Semiont project structure with environment config
 * for backend tests that import index.ts
 *
 * Uses CLI templates as source of truth for environment structure
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadEnvironmentConfig, type EnvironmentConfig } from '@semiont/core';

export interface TestEnvironmentConfig {
  testDir: string;
  config: EnvironmentConfig;
  cleanup: () => Promise<void>;
}

/**
 * Create a complete test environment with:
 * - Temporary directory
 * - semiont.json
 * - environments/{envName}.json based on CLI test.json template
 * - SEMIONT_ROOT and SEMIONT_ENV set
 *
 * @param envName - Optional environment name (defaults to SEMIONT_ENV or 'unit')
 */
export async function setupTestEnvironment(envName?: string): Promise<TestEnvironmentConfig> {
  // Use provided envName, or existing SEMIONT_ENV, or default to 'unit'
  const environment = envName || process.env.SEMIONT_ENV || 'unit';

  // Create temp directory
  const testDir = join(tmpdir(), `semiont-backend-test-${Date.now()}`);
  await fs.mkdir(testDir, { recursive: true });

  // Create environments directory
  const envDir = join(testDir, 'environments');
  await fs.mkdir(envDir, { recursive: true });

  // Create semiont.json
  const semiontConfig = {
    version: '1.0.0',
    project: 'test-backend',
    site: {
      siteName: 'Test Site',
      domain: 'localhost',
      adminEmail: 'admin@test.local'
    }
  };
  await fs.writeFile(
    join(testDir, 'semiont.json'),
    JSON.stringify(semiontConfig, null, 2)
  );

  // Load CLI test.json template as base
  const templatePath = resolve(__dirname, '../../../cli/templates/environments/test.json');
  const templateContent = await fs.readFile(templatePath, 'utf-8');
  const envConfig = JSON.parse(templateContent);

  // Customize for tests:
  // 1. Set name to match environment
  envConfig.name = environment;

  // 2. Use posix platform instead of containers for faster tests
  envConfig.platform.default = 'posix';
  envConfig.services.backend.platform.type = 'posix';
  envConfig.services.frontend.platform.type = 'posix';

  // 3. Set filesystem path to test directory
  envConfig.services.filesystem = {
    platform: { type: 'posix' },
    path: join(testDir, 'data'),
    description: 'Test filesystem storage'
  };

  await fs.writeFile(
    join(envDir, `${environment}.json`),
    JSON.stringify(envConfig, null, 2)
  );

  // Create data directory for filesystem service
  await fs.mkdir(join(testDir, 'data'), { recursive: true });

  // Set environment variables
  process.env.SEMIONT_ROOT = testDir;
  process.env.SEMIONT_ENV = environment;

  // Load the config we just created
  const config = loadEnvironmentConfig(testDir, environment);

  return {
    testDir,
    config,
    cleanup: async () => {
      delete process.env.SEMIONT_ROOT;
      delete process.env.SEMIONT_ENV;
      await fs.rm(testDir, { recursive: true, force: true });
    }
  };
}
