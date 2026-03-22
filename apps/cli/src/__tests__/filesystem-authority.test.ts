/**
 * TOML Config Authority Integration Test
 *
 * Proves that users can define environments in ~/.semiontconfig
 * and the CLI will accept them without any hardcoded restrictions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } from '../core/config-loader.js';

describe('TOML Config Authority for Environment Validation', () => {
  let testDir: string;
  let fakeHome: string;
  let originalHome: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME ?? os.homedir();

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-authority-test-'));
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

  it('should confirm TOML config authority over hardcoded environment lists', () => {
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.foo.backend]
platform = "posix"
port = 8080
publicURL = "http://foo.example.com:8080"
corsOrigin = "http://foo.example.com:3000"

[environments.foo.site]
domain = "foo.example.com"
adminEmail = "admin@foo.example.com"
`);

    const availableEnvironments = getAvailableEnvironments();
    expect(availableEnvironments).toContain('foo');

    expect(isValidEnvironment('foo')).toBe(true);

    const loadedConfig = loadEnvironmentConfig(testDir, 'foo');

    expect(loadedConfig).toBeDefined();
    expect(loadedConfig.site?.domain).toBe('foo.example.com');
    expect(loadedConfig.services?.backend?.port).toBe(8080);
    expect(loadedConfig.services?.backend?.publicURL).toBe('http://foo.example.com:8080');
  });

  it('should demonstrate that hardcoded environments are no longer required', () => {
    const customEnvironments = [
      'my-dev-branch',
      'customer-demo',
      'load-test-env',
      'feature-x-staging',
    ];

    const sections = customEnvironments.map(env => `
[environments.${env}.site]
domain = "${env}.example.com"
`).join('\n');

    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), sections);

    const available = getAvailableEnvironments();
    expect(available.sort()).toEqual(customEnvironments.sort());

    for (const env of customEnvironments) {
      expect(isValidEnvironment(env)).toBe(true);
    }

    expect(isValidEnvironment('local')).toBe(false);
    expect(isValidEnvironment('development')).toBe(false);
    expect(isValidEnvironment('staging')).toBe(false);
    expect(isValidEnvironment('production')).toBe(false);
  });

  it('should handle environment names that would break hardcoded validation', () => {
    const edgeCaseNames = [
      'env-with-dashes',
      'env_with_underscores',
      'env123',
      'very-long-environment-name-for-specific-use-case',
    ];

    const sections = edgeCaseNames.map(env => `
[environments.${env}.site]
domain = "${env}.test.local"
`).join('\n');

    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), sections);

    const available = getAvailableEnvironments();

    for (const envName of edgeCaseNames) {
      expect(available).toContain(envName);
      expect(isValidEnvironment(envName)).toBe(true);

      const config = loadEnvironmentConfig(testDir, envName);
      expect(config.site?.domain).toBe(`${envName}.test.local`);
    }
  });

  it('should prove TOML config is the single source of truth', () => {
    // No config yet — nothing valid
    expect(getAvailableEnvironments()).toEqual([]);
    expect(isValidEnvironment('local')).toBe(false);
    expect(isValidEnvironment('anything')).toBe(false);

    // Write one environment
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.new-env.backend]
platform = "posix"
port = 3001
`);

    expect(getAvailableEnvironments()).toEqual(['new-env']);
    expect(isValidEnvironment('new-env')).toBe(true);
    expect(isValidEnvironment('local')).toBe(false);

    // Add a second environment
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.new-env.backend]
platform = "posix"
port = 3001

[environments.another-env.backend]
platform = "posix"
port = 3002
`);

    const available = getAvailableEnvironments();
    expect(available.sort()).toEqual(['another-env', 'new-env']);
    expect(isValidEnvironment('new-env')).toBe(true);
    expect(isValidEnvironment('another-env')).toBe(true);

    // Remove new-env by overwriting config with only another-env
    fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.another-env.backend]
platform = "posix"
port = 3002
`);

    expect(getAvailableEnvironments()).toEqual(['another-env']);
    expect(isValidEnvironment('another-env')).toBe(true);
    expect(isValidEnvironment('new-env')).toBe(false);
  });
});
