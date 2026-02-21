/**
 * Environment Validation Tests
 * 
 * Tests that verify the CLI uses filesystem-based environment discovery
 * instead of hardcoded validation, ensuring users can create custom environments.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } from '../core/config-loader.js';

describe('Dynamic Environment Validation', () => {
  let testDir: string;
  let configDir: string;
  
  beforeEach(() => {
    // Create a temporary directory for test config files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-test-'));
    // Use the correct path structure (environments/ not config/environments/)
    configDir = path.join(testDir, 'environments');
    fs.mkdirSync(configDir, { recursive: true });
    
    // Create a semiont.json file so findProjectRoot can find it
    fs.writeFileSync(
      path.join(testDir, 'semiont.json'),
      JSON.stringify({ version: '1.0.0', project: 'test' }, null, 2)
    );
    
    // Set process.cwd to our test directory so findProjectRoot works
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);
    // Also set SEMIONT_ROOT to ensure findProjectRoot uses our test directory
    process.env.SEMIONT_ROOT = testDir;
  });
  
  afterEach(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.SEMIONT_ROOT;
    vi.restoreAllMocks();
  });
  
  describe('getAvailableEnvironments()', () => {
    it('should discover environments from filesystem', () => {
      // Create test environment files
      const testConfigs = {
        'local.json': { services: {}, platform: { default: 'container' } },
        'staging.json': { services: {}, platform: { default: 'aws' } },
        'custom.json': { services: {}, platform: { default: 'posix' } }
      };
      
      for (const [filename, config] of Object.entries(testConfigs)) {
        fs.writeFileSync(
          path.join(configDir, filename), 
          JSON.stringify(config, null, 2)
        );
      }
      
      const environments = getAvailableEnvironments();
      
      expect(environments).toEqual(['custom', 'local', 'staging']);
      expect(environments).not.toContain('development'); // Not created
      expect(environments).not.toContain('production');  // Not created
    });
    
    it('should return empty array when environments directory does not exist', () => {
      // Remove the environments directory
      fs.rmSync(configDir, { recursive: true, force: true });
      
      const environments = getAvailableEnvironments();
      expect(environments).toEqual([]);
    });
    
    it('should ignore non-json files', () => {
      // Create mixed files
      fs.writeFileSync(path.join(configDir, 'local.json'), '{"services":{}}');
      fs.writeFileSync(path.join(configDir, 'readme.txt'), 'not a config');
      fs.writeFileSync(path.join(configDir, 'backup.json.bak'), '{"old":"config"}');
      fs.writeFileSync(path.join(configDir, 'test.json'), '{"services":{}}');
      
      const environments = getAvailableEnvironments();
      expect(environments).toEqual(['local', 'test']);
    });
    
    it('should handle custom environment names', () => {
      // Test unusual but valid environment names
      const customEnvs = ['dev-branch-123', 'feature_test', 'user.local'];
      
      for (const env of customEnvs) {
        fs.writeFileSync(
          path.join(configDir, `${env}.json`),
          JSON.stringify({ services: {} })
        );
      }
      
      const environments = getAvailableEnvironments();
      expect(environments).toEqual(customEnvs.sort());
    });
  });
  
  describe('isValidEnvironment()', () => {
    beforeEach(() => {
      // Create some test environments
      const configs = ['local', 'staging', 'my-custom-env'];
      for (const env of configs) {
        fs.writeFileSync(
          path.join(configDir, `${env}.json`),
          JSON.stringify({ services: {} })
        );
      }
    });
    
    it('should validate existing environments', () => {
      expect(isValidEnvironment('local')).toBe(true);
      expect(isValidEnvironment('staging')).toBe(true);
      expect(isValidEnvironment('my-custom-env')).toBe(true);
    });
    
    it('should reject non-existent environments', () => {
      expect(isValidEnvironment('nonexistent')).toBe(false);
      expect(isValidEnvironment('production')).toBe(false); // Not created
    });
    
    it('should be case sensitive', () => {
      expect(isValidEnvironment('Local')).toBe(false);
      expect(isValidEnvironment('LOCAL')).toBe(false);
      expect(isValidEnvironment('local')).toBe(true);
    });
  });
  
  describe('loadEnvironmentConfig()', () => {
    it('should load custom environment configurations', () => {
      const customConfig = {
        platform: { default: 'posix' },
        site: { domain: 'custom.example.com' },
        services: {
          backend: {
            platform: { type: 'posix' },
            port: 8080,
            publicURL: 'http://custom.example.com:8080',
            corsOrigin: 'http://custom.example.com:3000'
          },
          frontend: {
            platform: { type: 'posix' },
            port: 3000,
            publicURL: 'http://custom.example.com:3000',
            siteName: 'Custom Site'
          }
        }
      };
      
      fs.writeFileSync(
        path.join(configDir, 'custom.json'),
        JSON.stringify(customConfig, null, 2)
      );
      
      const loaded = loadEnvironmentConfig(testDir, 'custom');
      
      expect(loaded.platform?.default).toBe('posix');
      expect(loaded.site?.domain).toBe('custom.example.com');
      expect(loaded.services?.backend?.port).toBe(8080);
      expect(loaded.services?.frontend?.port).toBe(3000);
    });
    
    it('should handle environments with no services defined', () => {
      const configWithoutServices = {
        platform: { default: 'aws' },
        site: { domain: 'example.com' }
      };
      
      fs.writeFileSync(
        path.join(configDir, 'minimal.json'),
        JSON.stringify(configWithoutServices, null, 2)
      );
      
      const loaded = loadEnvironmentConfig(testDir, 'minimal');
      
      expect(loaded.services).toEqual({});
      expect(loaded.platform?.default).toBe('aws');
    });
    
    it('should throw helpful error for missing config file', () => {
      expect(() => loadEnvironmentConfig(testDir, 'missing')).toThrow();
    });
    
    it('should throw helpful error for invalid JSON', () => {
      fs.writeFileSync(
        path.join(configDir, 'invalid.json'),
        '{ "services": { invalid json }'
      );
      
      expect(() => loadEnvironmentConfig(testDir, 'invalid')).toThrow();
    });
  });
});

describe('Environment Discovery Integration', () => {
  let testDir: string;
  let configDir: string;
  
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-test-'));
    // Use the correct path structure (environments/ not config/environments/)
    configDir = path.join(testDir, 'environments');
    fs.mkdirSync(configDir, { recursive: true });
    
    // Create a semiont.json file so findProjectRoot can find it
    fs.writeFileSync(
      path.join(testDir, 'semiont.json'),
      JSON.stringify({ version: '1.0.0', project: 'test' }, null, 2)
    );
    
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);
    // Set SEMIONT_ROOT to ensure findProjectRoot uses our test directory
    process.env.SEMIONT_ROOT = testDir;
  });
  
  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.SEMIONT_ROOT;
    vi.restoreAllMocks();
  });
  
  it('should demonstrate filesystem authority over hardcoded lists', () => {
    // Create environments that were NOT in the original hardcoded list
    const customEnvironments = [
      'demo',
      'sandbox', 
      'integration-test',
      'user-branch-feature-x'
    ];
    
    for (const env of customEnvironments) {
      const config = {
        platform: { default: 'container' },
        site: { domain: `${env}.example.com` },
        services: {
          backend: {
            platform: { type: 'container' },
            port: 3001,
            publicURL: `http://${env}.example.com:3001`,
            corsOrigin: `http://${env}.example.com:3000`
          },
          frontend: {
            platform: { type: 'container' },
            port: 3000,
            publicURL: `http://${env}.example.com:3000`,
            siteName: `${env} Site`
          }
        }
      };
      
      fs.writeFileSync(
        path.join(configDir, `${env}.json`),
        JSON.stringify(config, null, 2)
      );
    }
    
    const discovered = getAvailableEnvironments();
    
    // All custom environments should be discoverable
    for (const env of customEnvironments) {
      expect(discovered).toContain(env);
      expect(isValidEnvironment(env)).toBe(true);
      
      const config = loadEnvironmentConfig(testDir, env);
      expect(config.site?.domain).toBe(`${env}.example.com`);
    }
    
    // Verify the filesystem is the source of truth
    expect(discovered.length).toBe(customEnvironments.length);
    expect(discovered.sort()).toEqual(customEnvironments.sort());
  });
  
  it('should handle mixed standard and custom environments', () => {
    const allEnvironments = [
      'local',      // "Standard"
      'production', // "Standard" 
      'demo',       // Custom
      'feature-branch-abc', // Custom
      'integration' // Custom
    ];
    
    for (const env of allEnvironments) {
      fs.writeFileSync(
        path.join(configDir, `${env}.json`),
        JSON.stringify({ 
          platform: { default: 'posix' },
          services: {} 
        })
      );
    }
    
    const discovered = getAvailableEnvironments();
    expect(discovered.sort()).toEqual(allEnvironments.sort());
    
    // All should be valid regardless of whether they were in hardcoded lists
    for (const env of allEnvironments) {
      expect(isValidEnvironment(env)).toBe(true);
    }
  });
});