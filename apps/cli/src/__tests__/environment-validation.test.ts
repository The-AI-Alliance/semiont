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
import { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } from '../lib/deployment-resolver.js';

describe('Dynamic Environment Validation', () => {
  let testDir: string;
  let configDir: string;
  
  beforeEach(() => {
    // Create a temporary directory for test config files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-test-'));
    configDir = path.join(testDir, 'config', 'environments');
    fs.mkdirSync(configDir, { recursive: true });
    
    // Mock findProjectRoot to return our test directory
    vi.mock('../lib/deployment-resolver.js', async () => {
      const actual = await vi.importActual('../lib/deployment-resolver.js');
      return {
        ...actual,
        // Override only the functions that need mocking for our test
      };
    });
    
    // Set process.cwd to our test directory so findProjectRoot works
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  });
  
  afterEach(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  
  describe('getAvailableEnvironments()', () => {
    it('should discover environments from filesystem', () => {
      // Create test environment files
      const testConfigs = {
        'local.json': { services: {}, deployment: { default: 'container' } },
        'staging.json': { services: {}, deployment: { default: 'aws' } },
        'custom.json': { services: {}, deployment: { default: 'process' } }
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
    
    it('should return empty array when config directory does not exist', () => {
      // Remove the config directory
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
        deployment: { default: 'process' },
        site: { domain: 'custom.example.com' },
        services: {
          backend: { deployment: { type: 'process' }, port: 8080 },
          frontend: { deployment: { type: 'process' }, port: 3000 }
        }
      };
      
      fs.writeFileSync(
        path.join(configDir, 'custom.json'),
        JSON.stringify(customConfig, null, 2)
      );
      
      const loaded = loadEnvironmentConfig('custom');
      
      expect(loaded.deployment?.default).toBe('process');
      expect(loaded.site?.domain).toBe('custom.example.com');
      expect(loaded.services?.backend?.port).toBe(8080);
      expect(loaded.services?.frontend?.port).toBe(3000);
    });
    
    it('should handle environments with no services defined', () => {
      const configWithoutServices = {
        deployment: { default: 'aws' },
        site: { domain: 'example.com' }
      };
      
      fs.writeFileSync(
        path.join(configDir, 'minimal.json'),
        JSON.stringify(configWithoutServices, null, 2)
      );
      
      const loaded = loadEnvironmentConfig('minimal');
      
      expect(loaded.services).toEqual({});
      expect(loaded.deployment?.default).toBe('aws');
    });
    
    it('should throw helpful error for missing config file', () => {
      expect(() => loadEnvironmentConfig('missing')).toThrow();
    });
    
    it('should throw helpful error for invalid JSON', () => {
      fs.writeFileSync(
        path.join(configDir, 'invalid.json'),
        '{ "services": { invalid json }'
      );
      
      expect(() => loadEnvironmentConfig('invalid')).toThrow();
    });
  });
});

describe('Environment Discovery Integration', () => {
  let testDir: string;
  let configDir: string;
  
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-test-'));
    configDir = path.join(testDir, 'config', 'environments');
    fs.mkdirSync(configDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  });
  
  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
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
        deployment: { default: 'container' },
        site: { domain: `${env}.example.com` },
        services: {
          backend: { deployment: { type: 'container' }, port: 3001 },
          frontend: { deployment: { type: 'container' }, port: 3000 }
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
      
      const config = loadEnvironmentConfig(env);
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
          deployment: { default: 'process' },
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