/**
 * Environment Validation Tests
 *
 * Tests that verify the CLI uses TOML-based environment discovery from
 * ~/.semiontconfig instead of scanning environments/*.json files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } from '../core/config-loader.js';

function writeSemiontConfig(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, '.semiontconfig'), content);
}

describe('Dynamic Environment Validation', () => {
  let testDir: string;
  let fakeHome: string;
  let originalHome: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME ?? os.homedir();

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-test-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-home-'));

    // Create .semiont/ anchor so findProjectRoot() discovers it via upward walk
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

  describe('getAvailableEnvironments()', () => {
    it('should discover environments from TOML config', () => {
      writeSemiontConfig(fakeHome, `
[environments.local.backend]
port = 3001

[environments.staging.backend]
port = 3002

[environments.custom.backend]
port = 3003
`);

      const environments = getAvailableEnvironments();

      expect(environments).toEqual(['custom', 'local', 'staging']);
      expect(environments).not.toContain('development');
      expect(environments).not.toContain('production');
    });

    it('should return empty array when ~/.semiontconfig does not exist', () => {
      // fakeHome has no .semiontconfig
      const environments = getAvailableEnvironments();
      expect(environments).toEqual([]);
    });

    it('should return empty array when config has no environments section', () => {
      writeSemiontConfig(fakeHome, `
[user]
name = "Test User"
`);

      const environments = getAvailableEnvironments();
      expect(environments).toEqual([]);
    });

    it('should handle custom environment names', () => {
      writeSemiontConfig(fakeHome, `
[environments.dev-branch-123.backend]
port = 3001

[environments.feature_test.backend]
port = 3002
`);

      const environments = getAvailableEnvironments();
      expect(environments).toEqual(['dev-branch-123', 'feature_test']);
    });
  });

  describe('isValidEnvironment()', () => {
    beforeEach(() => {
      writeSemiontConfig(fakeHome, `
[environments.local.backend]
port = 3001

[environments.staging.backend]
port = 3002

[environments.my-custom-env.backend]
port = 3003
`);
    });

    it('should validate existing environments', () => {
      expect(isValidEnvironment('local')).toBe(true);
      expect(isValidEnvironment('staging')).toBe(true);
      expect(isValidEnvironment('my-custom-env')).toBe(true);
    });

    it('should reject non-existent environments', () => {
      expect(isValidEnvironment('nonexistent')).toBe(false);
      expect(isValidEnvironment('production')).toBe(false);
    });

    it('should be case sensitive', () => {
      expect(isValidEnvironment('Local')).toBe(false);
      expect(isValidEnvironment('LOCAL')).toBe(false);
      expect(isValidEnvironment('local')).toBe(true);
    });
  });

  describe('loadEnvironmentConfig()', () => {
    it('should load custom environment configurations', () => {
      writeSemiontConfig(fakeHome, `
[environments.custom.backend]
port = 8080
publicURL = "http://custom.example.com:8080"
corsOrigin = "http://custom.example.com:3000"

[environments.custom.site]
domain = "custom.example.com"
`);

      const loaded = loadEnvironmentConfig(testDir, 'custom');

      expect(loaded.site?.domain).toBe('custom.example.com');
      expect(loaded.services?.backend?.port).toBe(8080);
      expect(loaded.services?.backend?.publicURL).toBe('http://custom.example.com:8080');
    });

    it('should handle environments with no backend defined', () => {
      writeSemiontConfig(fakeHome, `
[environments.minimal.site]
domain = "example.com"
`);

      const loaded = loadEnvironmentConfig(testDir, 'minimal');

      expect(loaded.services?.backend).toBeUndefined();
      expect(loaded.site?.domain).toBe('example.com');
    });

    it('should throw when config file is missing', () => {
      // fakeHome has no .semiontconfig
      expect(() => loadEnvironmentConfig(testDir, 'missing')).toThrow();
    });

    it('should throw for invalid TOML', () => {
      fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), '[[invalid toml}}}');
      expect(() => loadEnvironmentConfig(testDir, 'invalid')).toThrow();
    });
  });
});

describe('Environment Discovery Integration', () => {
  let testDir: string;
  let fakeHome: string;
  let originalHome: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME ?? os.homedir();

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-test-'));
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

  it('should demonstrate TOML config as source of truth', () => {
    const customEnvironments = ['demo', 'sandbox', 'integration-test', 'user-branch-feature-x'];

    const sections = customEnvironments.map(env => `
[environments.${env}.backend]
port = 3001
publicURL = "http://${env}.example.com:3001"

[environments.${env}.site]
domain = "${env}.example.com"
`).join('\n');

    writeSemiontConfig(fakeHome, sections);

    const discovered = getAvailableEnvironments();

    for (const env of customEnvironments) {
      expect(discovered).toContain(env);
      expect(isValidEnvironment(env)).toBe(true);

      const config = loadEnvironmentConfig(testDir, env);
      expect(config.site?.domain).toBe(`${env}.example.com`);
    }

    expect(discovered.length).toBe(customEnvironments.length);
    expect(discovered.sort()).toEqual(customEnvironments.sort());
  });

  it('should handle mixed standard and custom environments', () => {
    writeSemiontConfig(fakeHome, `
[environments.local.backend]
port = 3001

[environments.production.backend]
port = 3001

[environments.demo.backend]
port = 3001

[environments.feature-branch-abc.backend]
port = 3001

[environments.integration.backend]
port = 3001
`);

    const allEnvironments = ['local', 'production', 'demo', 'feature-branch-abc', 'integration'];
    const discovered = getAvailableEnvironments();
    expect(discovered.sort()).toEqual(allEnvironments.sort());

    for (const env of allEnvironments) {
      expect(isValidEnvironment(env)).toBe(true);
    }
  });
});
