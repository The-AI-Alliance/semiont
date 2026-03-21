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

const MINIMAL_SEMIONTCONFIG = `
[environments.integration]
[environments.integration.backend]
port = 4000
publicURL = "http://localhost:4000"
corsOrigin = "http://localhost:3000"

[environments.integration.make-meaning.graph]
type = "memory"

[environments.integration.make-meaning.actors.gatherer.inference]
type = "ollama"
model = "llama3"

[environments.integration.make-meaning.actors.matcher.inference]
type = "ollama"
model = "llama3"

[environments.integration.workers.default.inference]
type = "ollama"
model = "llama3"

[environments.integration.site]
domain = "test.local"
siteName = "Test"
adminEmail = "admin@test.local"
oauthAllowedDomains = ["test.local"]

[environments.unit]
[environments.unit.backend]
port = 4000
publicURL = "http://localhost:4000"
corsOrigin = "http://localhost:3000"

[environments.unit.make-meaning.graph]
type = "memory"

[environments.unit.make-meaning.actors.gatherer.inference]
type = "ollama"
model = "llama3"

[environments.unit.make-meaning.actors.matcher.inference]
type = "ollama"
model = "llama3"

[environments.unit.workers.default.inference]
type = "ollama"
model = "llama3"

[environments.unit.site]
domain = "test.local"
siteName = "Test"
adminEmail = "admin@test.local"
oauthAllowedDomains = ["test.local"]
`;

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

  // Write a minimal .semiontconfig so loadEnvironmentConfig works without a real user home dir.
  // Set HOME to testDir so os.homedir() returns it.
  const originalHome = process.env.HOME;
  await fs.writeFile(join(testDir, '.semiontconfig'), MINIMAL_SEMIONTCONFIG, 'utf-8');
  process.env.HOME = testDir;

  process.env.SEMIONT_ROOT = testDir;
  process.env.SEMIONT_ENV = environment;

  const config: EnvironmentConfig = {
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
    site: {
      domain: 'test.local',
      siteName: 'Test',
      adminEmail: 'admin@test.local',
      oauthAllowedDomains: ['test.local'],
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
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      delete process.env.SEMIONT_ROOT;
      delete process.env.SEMIONT_ENV;
      await fs.rm(testDir, { recursive: true, force: true });
    },
  };
}
