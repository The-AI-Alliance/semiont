/**
 * CLI Environment Validation Tests
 *
 * Tests that verify the CLI properly validates environments dynamically
 * via TOML config and provides helpful error messages when environments are missing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } from '../core/config-loader.js';

describe('CLI Environment Validation Logic', () => {
  let testDir: string;
  let fakeHome: string;
  let originalHome: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME ?? os.homedir();

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-cli-test-'));
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

  describe('Environment Error Messages', () => {
    it('should provide helpful error when no environments exist', () => {
      // fakeHome has no .semiontconfig
      const environments = getAvailableEnvironments();

      expect(environments).toEqual([]);

      const errorMessage = environments.length === 0
        ? `No environment configurations found. Create files in environments/`
        : `Unknown environment 'test'. Available: ${environments.join(', ')}`;

      expect(errorMessage).toBe(`No environment configurations found. Create files in environments/`);
    });

    it('should list available environments in error messages', () => {
      fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.local.backend]
platform = "posix"
port = 3001

[environments.staging.backend]
platform = "posix"
port = 3002

[environments.custom-env.backend]
platform = "posix"
port = 3003
`);

      const environments = getAvailableEnvironments();
      const isValid = isValidEnvironment('nonexistent');

      expect(environments.sort()).toEqual(['custom-env', 'local', 'staging']);
      expect(isValid).toBe(false);

      const errorMessage = !isValid
        ? `Unknown environment 'nonexistent'. Available: ${environments.join(', ')}`
        : '';

      expect(errorMessage).toBe(`Unknown environment 'nonexistent'. Available: custom-env, local, staging`);
    });
  });

  describe('Dynamic Help Text', () => {
    it('should reflect discovered environments in help', () => {
      fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.dev.backend]
platform = "posix"
port = 3001

[environments.my-feature.backend]
platform = "posix"
port = 3002

[environments.prod.backend]
platform = "posix"
port = 3003
`);

      const environments = getAvailableEnvironments();
      const helpText = `Environment (${environments.join(', ') || 'none found'})`;

      expect(helpText).toBe('Environment (dev, my-feature, prod)');
    });

    it('should show "none found" when no environments exist', () => {
      // fakeHome has no .semiontconfig
      const environments = getAvailableEnvironments();
      const helpText = `Environment (${environments.join(', ') || 'none found'})`;

      expect(helpText).toBe('Environment (none found)');
    });
  });

  describe('Service Discovery with Custom Environments', () => {
    it('should load services from custom environment configs', () => {
      fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.demo.backend]
platform = "posix"
port = 8080
publicURL = "http://demo.example.com:8080"
corsOrigin = "http://demo.example.com:3000"

[environments.demo.site]
domain = "demo.example.com"
adminEmail = "admin@demo.example.com"
`);

      expect(isValidEnvironment('demo')).toBe(true);

      const config = loadEnvironmentConfig(testDir, 'demo');
      expect(config.services?.backend?.port).toBe(8080);
      expect(config.site?.domain).toBe('demo.example.com');
    });
  });

  describe('Configuration Loading', () => {
    it('should load complete environment configurations', () => {
      fs.writeFileSync(path.join(fakeHome, '.semiontconfig'), `
[environments.test.backend]
platform = "posix"
port = 4001
publicURL = "http://test.local:4001"
corsOrigin = "http://test.local:4000"

[environments.test.site]
domain = "test.local"
adminEmail = "admin@test.local"
`);

      expect(isValidEnvironment('test')).toBe(true);

      const loaded = loadEnvironmentConfig(testDir, 'test');

      expect(loaded.site).toBeDefined();
      expect(loaded.services).toBeDefined();
      expect(loaded.site?.domain).toBe('test.local');
      expect(loaded.services?.backend?.port).toBe(4001);
    });
  });
});
