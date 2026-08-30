/**
 * Test Environment Setup Utilities
 *
 * Creates a minimal EnvironmentConfig and MakeMeaningConfig in memory
 * for gateway integration tests.
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EnvironmentConfig } from '@semiont/core';

const MINIMAL_SEMIONTCONFIG = `
[environments.integration]
[environments.integration.gateway]
platform = "posix"
port = 4000
publicURL = "http://localhost:4000"

[environments.integration.make-meaning.graph]
type = "memory"

# Mandatory per MANDATORY-EMBEDDING D0+D1 — every config names both, nothing is
# defaulted. This TOML is written to disk and parsed by the real loader, so it
# needs the sections in their own right: the EnvironmentConfig object further
# down is a separate surface, and having only that one is what left the
# integration suite failing at loadEnvironmentConfig.
[environments.integration.vectors]
type = "memory"

[environments.integration.embedding]
type = "ollama"
model = "nomic-embed-text"

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
[environments.unit.gateway]
platform = "posix"
port = 4000
publicURL = "http://localhost:4000"

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
 * - SEMIONT_ROOT set in process.env; the environment selected by `[defaults]`
 *   in the generated .semiontconfig (as a real KB does)
 *
 * @param envName - Optional environment name (defaults to 'unit')
 */
export async function setupTestEnvironment(envName?: string): Promise<TestEnvironmentConfig> {
  const environment = envName ?? 'unit';

  // mkdtemp, not Date.now(): parallel test files calling this in the same
  // millisecond must not share (and mutually clobber) one directory.
  const testDir = await fs.mkdtemp(join(tmpdir(), 'semiont-gateway-test-'));

  const dataPath = join(testDir, 'data');
  await fs.mkdir(dataPath, { recursive: true });

  // Write a minimal .semiontconfig so loadEnvironmentConfig works without a real user home dir.
  // Set HOME to testDir so os.homedir() returns it.
  //
  // `[defaults] environment` is prepended rather than baked into the constant because the
  // constant declares BOTH sections and the caller picks one. This is how a real KB selects
  // its environment, so the fixture selects it the same way — no ambient SEMIONT_ENV.
  //
  // `[kb]` is the launcher-staged identity card (SINGLE-KB-MOUNT P5): the
  // gateway mounts no KB tree, so this is the only place it can see the
  // committed `name` and `domain`. Written into the PREPEND, beside
  // `[defaults]`, because both are top-level and TOML assigns any key after
  // the first `[environments…]` header to that table instead.
  const originalHome = process.env.HOME;
  await fs.writeFile(
    join(testDir, '.semiontconfig'),
    `[defaults]\nenvironment = "${environment}"\n\n` +
      `[kb]\nname = "semiont-gateway-test"\ndomain = "test.local"\n` +
      MINIMAL_SEMIONTCONFIG,
    'utf-8',
  );
  process.env.HOME = testDir;

  // The KB's OWN committed config — the file the launcher READS to produce the
  // staged `[kb]` above. The gateway no longer opens it (it has no KB mount),
  // but the CLIs still do, and it is what makes this fixture a valid knowledge
  // base rather than a directory. The domain matches the staged and
  // environment values on purpose: these fixtures should represent the
  // ordinary, non-diverged case and stay silent (a mismatch warns —
  // KB-IDENTITY-VS-ADDRESS decision 10).
  await fs.mkdir(join(testDir, '.semiont'), { recursive: true });
  await fs.writeFile(
    join(testDir, '.semiont', 'config'),
    '[project]\nname = "semiont-gateway-test"\n\n[site]\ndomain = "test.local"\n',
    'utf-8',
  );

  process.env.SEMIONT_ROOT = testDir;
  // Beside SEMIONT_ROOT because it is the same kind of thing: a deployment
  // fact index.ts reads and refuses to boot without. Set HERE rather than in a
  // suite's setup file because this helper is what both suites share — the
  // unit setup, the integration setup, and the test files that call it
  // directly. A suite-level copy covers one of those.
  process.env.SEMIONT_ANCHORED_TEXT_DIR = join(testDir, 'anchored-text');

  const config: EnvironmentConfig = {
    services: {
      gateway: {
        platform: { type: 'posix' },
        port: 4000,
        publicURL: 'http://localhost:4000',
      },
      graph: {
        platform: { type: 'posix' },
        type: 'memory',
      },
      // Mandatory per MANDATORY-EMBEDDING D0+D1 — every config names both.
      vectors: {
        platform: { type: 'external' },
        type: 'memory',
      },
      embedding: {
        platform: { type: 'external' },
        type: 'ollama',
        model: 'nomic-embed-text',
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
      await fs.rm(testDir, { recursive: true, force: true });
    },
  };
}
