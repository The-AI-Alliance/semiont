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
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createConfigLoader, type EnvironmentConfig } from '@semiont/core';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TestEnvironmentConfig {
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

  // 4. Add inference config for tests (mocked, but config must exist)
  envConfig.services.inference = {
    platform: { type: 'external' },
    type: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
    endpoint: 'https://api.anthropic.com',
    apiKey: 'test-api-key'
  };

  // 5. Add graph config for tests (required by make-meaning service)
  envConfig.services.graph = {
    platform: { type: 'posix' },
    type: 'memory'
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

  // Load the config we just created using async file reader
  const asyncFileReader = {
    readIfExists: async (filePath: string) => {
      try {
        return await fs.readFile(filePath, 'utf-8');
      } catch {
        return null;
      }
    },
    readRequired: async (filePath: string) => {
      return await fs.readFile(filePath, 'utf-8');
    },
  };

  // Create loader and read files
  const baseContent = await asyncFileReader.readIfExists(join(testDir, 'semiont.json'));
  const envContent = await asyncFileReader.readRequired(join(envDir, `${environment}.json`));

  // Use sync version of createConfigLoader for the actual parsing
  const loadConfig = createConfigLoader({
    readIfExists: () => baseContent,
    readRequired: () => envContent!,
  });
  const config = loadConfig(testDir, environment);

  return {
    config,
    cleanup: async () => {
      delete process.env.SEMIONT_ROOT;
      delete process.env.SEMIONT_ENV;
      await fs.rm(testDir, { recursive: true, force: true });
    }
  };
}
