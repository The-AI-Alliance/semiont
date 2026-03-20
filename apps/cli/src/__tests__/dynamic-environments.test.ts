/**
 * Dynamic Environment Discovery Tests
 *
 * Tests that verify the CLI uses TOML-based environment discovery from
 * ~/.semiontconfig instead of hardcoded validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } from '../core/config-loader.js';

describe('Dynamic Environment Discovery', () => {
  let testDir: string;
  let fakeHome: string;
  let originalHome: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME ?? os.homedir();

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-env-test-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-home-'));

    fs.mkdirSync(path.join(testDir, '.semiont'), { recursive: true });

    process.env.HOME = fakeHome;
    process.chdir(testDir);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('should discover custom environments from TOML config', () => {
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.demo.backend]
port = 4000
publicURL = "http://demo.local:4000"
corsOrigin = "http://demo.local:3000"

[environments.demo.site]
domain = "demo.local"

[environments.feature-branch.backend]
port = 8080
publicURL = "http://feature.local:8080"
corsOrigin = "http://feature.local:3000"

[environments.feature-branch.site]
domain = "feature.local"

[environments.user-test.site]
domain = "usertest.com"
`);

    const discovered = getAvailableEnvironments();

    expect(discovered.sort()).toEqual(['demo', 'feature-branch', 'user-test']);

    expect(isValidEnvironment('demo')).toBe(true);
    expect(isValidEnvironment('feature-branch')).toBe(true);
    expect(isValidEnvironment('user-test')).toBe(true);

    expect(isValidEnvironment('production')).toBe(false);
    expect(isValidEnvironment('staging')).toBe(false);

    const demoConfig = loadEnvironmentConfig(testDir, 'demo');
    expect(demoConfig.site?.domain).toBe('demo.local');
    expect(demoConfig.services?.backend).toBeDefined();

    const featureConfig = loadEnvironmentConfig(testDir, 'feature-branch');
    expect(featureConfig.site?.domain).toBe('feature.local');
  });

  it('should handle mixed standard and custom environments', () => {
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.local.backend]
port = 3001

[environments.production.backend]
port = 3001

[environments.my-custom-env.backend]
port = 3001
`);

    const discovered = getAvailableEnvironments();

    expect(discovered.sort()).toEqual(['local', 'my-custom-env', 'production']);

    expect(isValidEnvironment('local')).toBe(true);
    expect(isValidEnvironment('production')).toBe(true);
    expect(isValidEnvironment('my-custom-env')).toBe(true);

    expect(isValidEnvironment('development')).toBe(false);
    expect(isValidEnvironment('staging')).toBe(false);
  });

  it('should return empty array when no config file exists', () => {
    // fakeHome has no .semiontconfig
    const environments = getAvailableEnvironments();
    expect(environments).toEqual([]);
  });

  it('should return empty array when config has no environments section', () => {
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[user]
name = "Test User"
`);

    const environments = getAvailableEnvironments();
    expect(environments).toEqual([]);
  });

  it('should demonstrate TOML config authority over hardcoded validation', () => {
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.sandbox.backend]
port = 8080
publicURL = "http://sandbox.example.com:8080"
corsOrigin = "http://sandbox.example.com:3000"

[environments.sandbox.site]
domain = "sandbox.example.com"

[environments.integration-testing.site]
domain = "integration.example.com"
`);

    expect(isValidEnvironment('sandbox')).toBe(true);
    expect(isValidEnvironment('integration-testing')).toBe(true);

    const environments = getAvailableEnvironments();
    expect(environments).toContain('sandbox');
    expect(environments).toContain('integration-testing');

    const sandboxConfig = loadEnvironmentConfig(testDir, 'sandbox');
    expect(sandboxConfig.services?.backend?.port).toBe(8080);

    const integrationConfig = loadEnvironmentConfig(testDir, 'integration-testing');
    expect(integrationConfig.site?.domain).toBe('integration.example.com');
  });
});
