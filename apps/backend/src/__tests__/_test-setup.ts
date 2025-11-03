/**
 * Test Environment Setup Utilities
 *
 * Creates proper Semiont project structure with environment config
 * for backend tests that import index.ts
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface TestEnvironmentConfig {
  testDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a complete test environment with:
 * - Temporary directory
 * - semiont.json
 * - environments/unit.json with proper backend config
 * - SEMIONT_ROOT and SEMIONT_ENV set
 */
export async function setupTestEnvironment(): Promise<TestEnvironmentConfig> {
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

  // Create environments/unit.json with all required config
  const unitConfig = {
    services: {
      backend: {
        port: 4000,
        corsOrigin: 'http://localhost:3000',
        publicUrl: 'http://localhost:4000',
        publicURL: 'http://localhost:4000'
      },
      frontend: {
        url: 'http://localhost:3000',
        port: 3000
      },
      filesystem: {
        path: join(testDir, 'data')
      }
    },
    env: {
      NODE_ENV: 'test'
    }
  };
  await fs.writeFile(
    join(envDir, 'unit.json'),
    JSON.stringify(unitConfig, null, 2)
  );

  // Create data directory for filesystem service
  await fs.mkdir(join(testDir, 'data'), { recursive: true });

  // Set environment variables
  process.env.SEMIONT_ROOT = testDir;
  process.env.SEMIONT_ENV = 'unit';

  return {
    testDir,
    cleanup: async () => {
      delete process.env.SEMIONT_ROOT;
      delete process.env.SEMIONT_ENV;
      await fs.rm(testDir, { recursive: true, force: true });
    }
  };
}
