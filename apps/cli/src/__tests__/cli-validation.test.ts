/**
 * CLI Environment Validation Tests
 * 
 * Tests that verify the main CLI properly validates environments dynamically
 * and provides helpful error messages when environments are missing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We'll test the CLI argument parsing logic indirectly by testing the 
// functions it calls, since the main CLI does process.exit() which is
// hard to test directly.

describe('CLI Environment Validation Logic', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-cli-test-'));
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
  
  describe('Environment Error Messages', () => {
    it('should provide helpful error when no environments exist', async () => {
      // Remove environments directory entirely
      fs.rmSync(configDir, { recursive: true, force: true });
      
      const { getAvailableEnvironments } = await import('../platforms/platform-resolver.js');
      const environments = getAvailableEnvironments();
      
      expect(environments).toEqual([]);
      
      // This simulates what the CLI would do
      const errorMessage = environments.length === 0 
        ? `No environment configurations found. Create files in environments/`
        : `Unknown environment 'test'. Available: ${environments.join(', ')}`;
      
      expect(errorMessage).toBe(`No environment configurations found. Create files in environments/`);
    });
    
    it('should list available environments in error messages', async () => {
      // Create some test environments
      const testEnvs = ['local', 'staging', 'custom-env'];
      for (const env of testEnvs) {
        fs.writeFileSync(
          path.join(configDir, `${env}.json`),
          JSON.stringify({ services: {} })
        );
      }
      
      const { getAvailableEnvironments, isValidEnvironment } = await import('../platforms/platform-resolver.js');
      
      const environments = getAvailableEnvironments();
      const isValid = isValidEnvironment('nonexistent');
      
      expect(environments.sort()).toEqual(['custom-env', 'local', 'staging']);
      expect(isValid).toBe(false);
      
      // This simulates the CLI error message logic
      const errorMessage = !isValid 
        ? `Unknown environment 'nonexistent'. Available: ${environments.join(', ')}`
        : '';
      
      expect(errorMessage).toBe(`Unknown environment 'nonexistent'. Available: custom-env, local, staging`);
    });
  });
  
  describe('Dynamic Help Text', () => {
    it('should reflect discovered environments in help', async () => {
      const testEnvs = ['dev', 'prod', 'my-feature'];
      for (const env of testEnvs) {
        fs.writeFileSync(
          path.join(configDir, `${env}.json`),
          JSON.stringify({ 
            platform: { default: 'process' },
            services: {} 
          })
        );
      }
      
      const { getAvailableEnvironments } = await import('../platforms/platform-resolver.js');
      const environments = getAvailableEnvironments();
      
      // This simulates the help text generation
      const helpText = `Environment (${environments.join(', ') || 'none found'})`;
      
      expect(helpText).toBe('Environment (dev, my-feature, prod)');
    });
    
    it('should show "none found" when no environments exist', async () => {
      fs.rmSync(configDir, { recursive: true, force: true });
      
      const { getAvailableEnvironments } = await import('../platforms/platform-resolver.js');
      const environments = getAvailableEnvironments();
      
      const helpText = `Environment (${environments.join(', ') || 'none found'})`;
      
      expect(helpText).toBe('Environment (none found)');
    });
  });
  
  describe('Service Discovery with Custom Environments', () => {
    it('should load services from custom environment configs', async () => {
      const customConfig = {
        platform: { default: 'container' },
        site: {
          domain: 'demo.example.com',
          adminEmail: 'admin@demo.example.com'
        },
        services: {
          api: {
            platform: { type: 'container' },
            port: 8080,
            image: 'my-api:latest'
          },
          web: {
            platform: { type: 'container' },
            port: 3000,
            image: 'my-web:latest'
          },
          cache: {
            platform: { type: 'container' },
            port: 6379,
            image: 'redis:7'
          }
        }
      };
      
      fs.writeFileSync(
        path.join(configDir, 'demo.json'),
        JSON.stringify(customConfig, null, 2)
      );
      
      const { loadEnvironmentConfig, isValidEnvironment } = await import('../platforms/platform-resolver.js');
      
      expect(isValidEnvironment('demo')).toBe(true);
      
      const config = loadEnvironmentConfig('demo');
      expect(config.services).toHaveProperty('api');
      expect(config.services).toHaveProperty('web');
      expect(config.services).toHaveProperty('cache');
      expect(config.services?.api?.port).toBe(8080);
      expect(config.site?.domain).toBe('demo.example.com');
    });
  });
  
  describe('Configuration Validation', () => {
    it('should validate complete environment configurations', async () => {
      const validConfig = {
        platform: { default: 'process' },
        site: {
          domain: 'test.local',
          adminEmail: 'admin@test.local',
          supportEmail: 'support@test.local'
        },
        app: {
          features: {
            enableAnalytics: false,
            enableMaintenanceMode: false
          },
          security: {
            sessionTimeout: 3600,
            maxLoginAttempts: 5
          }
        },
        services: {
          backend: {
            platform: { type: 'process' },
            port: 4001,
            command: 'npm start'
          },
          frontend: {
            platform: { type: 'process' },
            port: 4000,
            command: 'npm start'
          }
        }
      };
      
      fs.writeFileSync(
        path.join(configDir, 'test.json'),
        JSON.stringify(validConfig, null, 2)
      );
      
      const { loadEnvironmentConfig, isValidEnvironment } = await import('../platforms/platform-resolver.js');
      
      expect(isValidEnvironment('test')).toBe(true);
      
      const loaded = loadEnvironmentConfig('test');
      
      // Verify all sections are present
      expect(loaded.deployment).toBeDefined();
      expect(loaded.site).toBeDefined();
      expect(loaded.app).toBeDefined();
      expect(loaded.services).toBeDefined();
      
      // Verify specific values
      expect(loaded.site?.domain).toBe('test.local');
      expect(loaded.app?.security?.sessionTimeout).toBe(3600);
      expect(loaded.services?.backend?.port).toBe(4001);
      expect(loaded.services?.frontend?.port).toBe(4000);
    });
  });
});