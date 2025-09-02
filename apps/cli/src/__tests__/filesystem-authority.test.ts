/**
 * Filesystem Authority Integration Test
 * 
 * This test proves that users can create new environment configurations
 * and the CLI will accept them without any hardcoded restrictions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Filesystem Authority for Environment Validation', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-authority-test-'));
    // Use the correct path structure (environments/ not config/environments/)
    configDir = path.join(testDir, 'environments');
    fs.mkdirSync(configDir, { recursive: true });
    
    // Create a semiont.json file so findProjectRoot can find it
    fs.writeFileSync(
      path.join(testDir, 'semiont.json'),
      JSON.stringify({ version: '1.0.0', project: 'test' }, null, 2)
    );
    
    process.chdir(testDir);
    // Set SEMIONT_ROOT to ensure findProjectRoot uses our test directory
    process.env.SEMIONT_ROOT = testDir;
  });
  
  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.SEMIONT_ROOT;
    fs.rmSync(testDir, { recursive: true, force: true });
  });
  
  it('should confirm filesystem authority over hardcoded environment lists', async () => {
    // This is the exact scenario from your question:
    // "confirm that if a user were to create a new config file, 
    // say 'config/environments/foo.json', that a '-e foo' passed to 
    // a cli command would find and parse the correct config file without error"
    
    const fooConfig = {
      "_comment": "Custom foo environment - this would have been rejected by hardcoded validation",
      "deployment": {
        "default": "container"
      },
      "site": {
        "domain": "foo.example.com",
        "adminEmail": "admin@foo.example.com",
        "supportEmail": "support@foo.example.com"
      },
      "app": {
        "features": {
          "enableAnalytics": true,
          "enableMaintenanceMode": false,
          "enableDebugLogging": true
        },
        "security": {
          "sessionTimeout": 7200,
          "maxLoginAttempts": 3,
          "corsAllowedOrigins": ["https://foo.example.com"]
        },
        "performance": {
          "enableCaching": true,
          "cacheTimeout": 300
        }
      },
      "services": {
        "backend": {
          "deployment": {
            "type": "container"
          },
          "port": 8080,
          "image": "my-backend:foo",
          "command": "npm start"
        },
        "frontend": {
          "deployment": {
            "type": "container"
          },
          "port": 3000,
          "image": "my-frontend:foo",
          "command": "npm run start"
        },
        "database": {
          "deployment": {
            "type": "container"
          },
          "host": "localhost",
          "port": 5432,
          "name": "semiont_foo",
          "user": "postgres"
        },
        "filesystem": {
          "deployment": {
            "type": "container"
          },
          "path": "/data/foo"
        }
      }
    };
    
    // Create the foo.json file
    fs.writeFileSync(
      path.join(configDir, 'foo.json'),
      JSON.stringify(fooConfig, null, 2)
    );
    
    // Import the CLI validation functions
    const { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } = 
      await import('../platforms/platform-resolver.js');
    
    // Test 1: Environment discovery should find 'foo'
    const availableEnvironments = getAvailableEnvironments();
    expect(availableEnvironments).toContain('foo');
    
    // Test 2: Environment validation should accept 'foo'
    expect(isValidEnvironment('foo')).toBe(true);
    
    // Test 3: Configuration loading should parse foo.json correctly
    const loadedConfig = loadEnvironmentConfig('foo');
    
    expect(loadedConfig).toBeDefined();
    expect(loadedConfig.site?.domain).toBe('foo.example.com');
    expect(loadedConfig.services?.backend?.port).toBe(8080);
    expect(loadedConfig.services?.frontend?.port).toBe(3000);
    expect(loadedConfig.services?.database?.name).toBe('semiont_foo');
    expect(loadedConfig.services?.filesystem?.path).toBe('/data/foo');
    
    // Test 4: All services should be properly configured
    expect(Object.keys(loadedConfig.services || {})).toEqual(
      expect.arrayContaining(['backend', 'frontend', 'database', 'filesystem'])
    );
    
    // Test 5: Deployment types should be read correctly
    expect(loadedConfig.services?.backend?.deployment?.type).toBe('container');
    expect(loadedConfig.services?.frontend?.deployment?.type).toBe('container');
    expect(loadedConfig.deployment?.default).toBe('container');
    
    // Test 6: App configuration should be fully accessible
    expect(loadedConfig.app?.features?.enableAnalytics).toBe(true);
    expect(loadedConfig.app?.security?.sessionTimeout).toBe(7200);
    expect(loadedConfig.app?.performance?.enableCaching).toBe(true);
  });
  
  it('should demonstrate that hardcoded environments are no longer required', async () => {
    // Create ONLY custom environments, none of the "standard" ones
    const customEnvironments = [
      'my-dev-branch',
      'customer-demo',
      'load-test-env',
      'feature-x-staging'
    ];
    
    for (const envName of customEnvironments) {
      const config = {
        platform: { default: 'posix' },
        site: { domain: `${envName}.example.com` },
        services: {
          api: { platform: { type: 'posix' }, port: 4000 },
          web: { platform: { type: 'posix' }, port: 3000 }
        }
      };
      
      fs.writeFileSync(
        path.join(configDir, `${envName}.json`),
        JSON.stringify(config, null, 2)
      );
    }
    
    const { getAvailableEnvironments, isValidEnvironment } = 
      await import('../platforms/platform-resolver.js');
    
    const available = getAvailableEnvironments();
    
    // Only custom environments should be available
    expect(available.sort()).toEqual(customEnvironments.sort());
    
    // All custom environments should be valid
    for (const env of customEnvironments) {
      expect(isValidEnvironment(env)).toBe(true);
    }
    
    // Traditional "hardcoded" environments should NOT be valid
    // because they don't exist in the filesystem
    expect(isValidEnvironment('local')).toBe(false);
    expect(isValidEnvironment('development')).toBe(false); 
    expect(isValidEnvironment('staging')).toBe(false);
    expect(isValidEnvironment('production')).toBe(false);
  });
  
  it('should handle environment names that would break hardcoded validation', async () => {
    // Test unusual but valid environment names that hardcoded lists couldn't handle
    const edgeCaseNames = [
      'env-with-dashes',
      'env_with_underscores',
      'env.with.dots',
      'MixedCaseEnv',
      'env123',
      '2023-migration-env',
      'very-long-environment-name-for-specific-use-case'
    ];
    
    for (const envName of edgeCaseNames) {
      const config = {
        platform: { default: 'aws' },
        site: { domain: `${envName}.test.local` },
        services: {
          service1: { platform: { type: 'aws' } }
        }
      };
      
      fs.writeFileSync(
        path.join(configDir, `${envName}.json`),
        JSON.stringify(config, null, 2)
      );
    }
    
    const { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } = 
      await import('../platforms/platform-resolver.js');
    
    const available = getAvailableEnvironments();
    
    // All edge case names should be discovered
    for (const envName of edgeCaseNames) {
      expect(available).toContain(envName);
      expect(isValidEnvironment(envName)).toBe(true);
      
      const config = loadEnvironmentConfig(envName);
      expect(config.site?.domain).toBe(`${envName}.test.local`);
    }
  });
  
  it('should prove the filesystem is the single source of truth', async () => {
    // Start with no environments
    expect(fs.readdirSync(configDir)).toEqual([]);
    
    const { getAvailableEnvironments, isValidEnvironment } = 
      await import('../platforms/platform-resolver.js');
    
    // Nothing should be valid initially
    expect(getAvailableEnvironments()).toEqual([]);
    expect(isValidEnvironment('local')).toBe(false);
    expect(isValidEnvironment('production')).toBe(false);
    expect(isValidEnvironment('anything')).toBe(false);
    
    // Add one environment
    fs.writeFileSync(
      path.join(configDir, 'new-env.json'),
      JSON.stringify({ platform: { default: 'posix' }, services: {} })
    );
    
    // Now only that environment should be valid
    expect(getAvailableEnvironments()).toEqual(['new-env']);
    expect(isValidEnvironment('new-env')).toBe(true);
    expect(isValidEnvironment('local')).toBe(false);
    
    // Add another environment
    fs.writeFileSync(
      path.join(configDir, 'another-env.json'),
      JSON.stringify({ platform: { default: 'aws' }, services: {} })
    );
    
    // Both should now be valid
    const available = getAvailableEnvironments();
    expect(available.sort()).toEqual(['another-env', 'new-env']);
    expect(isValidEnvironment('new-env')).toBe(true);
    expect(isValidEnvironment('another-env')).toBe(true);
    
    // Remove one environment
    fs.unlinkSync(path.join(configDir, 'new-env.json'));
    
    // Only the remaining environment should be valid
    expect(getAvailableEnvironments()).toEqual(['another-env']);
    expect(isValidEnvironment('another-env')).toBe(true);
    expect(isValidEnvironment('new-env')).toBe(false);
  });
});