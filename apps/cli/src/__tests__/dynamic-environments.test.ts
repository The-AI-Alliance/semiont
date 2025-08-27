/**
 * Dynamic Environment Discovery Tests
 * 
 * Core tests that verify the CLI uses filesystem-based environment discovery
 * instead of hardcoded validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Dynamic Environment Discovery', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-env-test-'));
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
  
  it('should discover custom environments from filesystem', async () => {
    // Create custom environment files that would NOT be in hardcoded lists
    const customEnvironments = {
      'demo.json': {
        platform: { default: 'process' },
        site: { domain: 'demo.local' },
        services: { backend: { platform: { type: 'process' } } }
      },
      'feature-branch.json': {
        platform: { default: 'container' },
        site: { domain: 'feature.local' },
        services: { api: { platform: { type: 'container' } } }
      },
      'user-test.json': {
        platform: { default: 'aws' },
        site: { domain: 'usertest.com' },
        services: { web: { platform: { type: 'aws' } } }
      }
    };
    
    // Write the config files
    for (const [filename, config] of Object.entries(customEnvironments)) {
      fs.writeFileSync(
        path.join(configDir, filename),
        JSON.stringify(config, null, 2)
      );
    }
    
    // Import the modules after setting up the filesystem
    const { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } = 
      await import('../lib/platform-resolver.js');
    
    const discovered = getAvailableEnvironments();
    
    // Should discover all custom environments
    expect(discovered.sort()).toEqual(['demo', 'feature-branch', 'user-test']);
    
    // All should be valid
    expect(isValidEnvironment('demo')).toBe(true);
    expect(isValidEnvironment('feature-branch')).toBe(true);
    expect(isValidEnvironment('user-test')).toBe(true);
    
    // Should NOT be valid if not in filesystem
    expect(isValidEnvironment('production')).toBe(false);
    expect(isValidEnvironment('staging')).toBe(false);
    
    // Should load configurations correctly
    const demoConfig = loadEnvironmentConfig('demo');
    expect(demoConfig.site?.domain).toBe('demo.local');
    expect(demoConfig.services?.backend).toBeDefined();
    
    const featureConfig = loadEnvironmentConfig('feature-branch');
    expect(featureConfig.site?.domain).toBe('feature.local');
    expect(featureConfig.services?.api).toBeDefined();
  });
  
  it('should handle mixed standard and custom environments', async () => {
    const mixedEnvironments = {
      'local.json': {
        platform: { default: 'container' },
        site: { domain: 'localhost' },
        services: { backend: { platform: { type: 'container' } } }
      },
      'production.json': {
        platform: { default: 'aws' },
        site: { domain: 'prod.example.com' },
        services: { backend: { platform: { type: 'aws' } } }
      },
      'my-custom-env.json': {
        platform: { default: 'process' },
        site: { domain: 'custom.local' },
        services: { backend: { platform: { type: 'process' } } }
      }
    };
    
    for (const [filename, config] of Object.entries(mixedEnvironments)) {
      fs.writeFileSync(
        path.join(configDir, filename),
        JSON.stringify(config, null, 2)
      );
    }
    
    const { getAvailableEnvironments, isValidEnvironment } = 
      await import('../lib/platform-resolver.js');
    
    const discovered = getAvailableEnvironments();
    
    // Should discover all environments regardless of "standard" vs "custom"
    expect(discovered.sort()).toEqual(['local', 'my-custom-env', 'production']);
    
    // All should be equally valid - no special treatment for "standard" names
    expect(isValidEnvironment('local')).toBe(true);
    expect(isValidEnvironment('production')).toBe(true);
    expect(isValidEnvironment('my-custom-env')).toBe(true);
    
    // Filesystem is the authority
    expect(isValidEnvironment('development')).toBe(false); // Not created
    expect(isValidEnvironment('staging')).toBe(false);     // Not created
  });
  
  it('should return empty array when no environments exist', async () => {
    // Remove config directory entirely
    fs.rmSync(configDir, { recursive: true, force: true });
    
    const { getAvailableEnvironments } = await import('../lib/platform-resolver.js');
    
    const environments = getAvailableEnvironments();
    expect(environments).toEqual([]);
  });
  
  it('should ignore non-json files', async () => {
    fs.writeFileSync(path.join(configDir, 'valid.json'), JSON.stringify({ services: {} }));
    fs.writeFileSync(path.join(configDir, 'readme.txt'), 'not a config');
    fs.writeFileSync(path.join(configDir, 'backup.json.bak'), 'old config');
    fs.writeFileSync(path.join(configDir, 'script.js'), 'console.log("hello")');
    
    const { getAvailableEnvironments } = await import('../lib/platform-resolver.js');
    
    const environments = getAvailableEnvironments();
    expect(environments).toEqual(['valid']);
  });
  
  it('should demonstrate filesystem authority over hardcoded validation', async () => {
    // This is the key test - create environments that would have been
    // rejected by the old hardcoded ['local', 'development', 'staging', 'production']
    
    const newEnvironments = {
      'sandbox.json': {
        platform: { default: 'container' },
        site: { domain: 'sandbox.example.com' },
        services: { 
          api: { platform: { type: 'container' }, port: 8080 },
          web: { platform: { type: 'container' }, port: 3000 }
        }
      },
      'integration-testing.json': {
        platform: { default: 'aws' },
        site: { domain: 'integration.example.com' },
        services: {
          backend: { platform: { type: 'aws' } },
          database: { platform: { type: 'aws' } }
        }
      }
    };
    
    for (const [filename, config] of Object.entries(newEnvironments)) {
      fs.writeFileSync(
        path.join(configDir, filename),
        JSON.stringify(config, null, 2)
      );
    }
    
    const { getAvailableEnvironments, isValidEnvironment, loadEnvironmentConfig } = 
      await import('../lib/platform-resolver.js');
    
    // These would have been rejected by hardcoded validation
    expect(isValidEnvironment('sandbox')).toBe(true);
    expect(isValidEnvironment('integration-testing')).toBe(true);
    
    // Should be discoverable
    const environments = getAvailableEnvironments();
    expect(environments).toContain('sandbox');
    expect(environments).toContain('integration-testing');
    
    // Should load correctly
    const sandboxConfig = loadEnvironmentConfig('sandbox');
    expect(sandboxConfig.services?.api?.port).toBe(8080);
    expect(sandboxConfig.services?.web?.port).toBe(3000);
    
    const integrationConfig = loadEnvironmentConfig('integration-testing');
    expect(integrationConfig.deployment?.default).toBe('aws');
    expect(integrationConfig.site?.domain).toBe('integration.example.com');
  });
});