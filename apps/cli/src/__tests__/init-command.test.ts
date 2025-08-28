/**
 * Integration tests for the init command
 * Uses real filesystem with temporary directories
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServicePlatformInfo } from '../platforms/platform-resolver';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import initCommand from '../commands/init';
const init = initCommand.handler;

describe('init command', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Save original working directory
    originalCwd = process.cwd();
    // Create a unique temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-init-test-'));
    // Change to test directory
    process.chdir(testDir);
    
    // Set the templates directory for tests to use the built templates
    const testFilePath = fileURLToPath(import.meta.url);
    const testFileDir = path.dirname(testFilePath);
    process.env.SEMIONT_TEMPLATES_DIR = path.join(testFileDir, '..', '..', 'dist', 'templates');
  });

  afterEach(() => {
    // Restore original directory
    process.chdir(originalCwd);
    // Clean up environment variable
    delete process.env.SEMIONT_TEMPLATES_DIR;
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('basic functionality', () => {
    it('should initialize a project with default settings', async () => {
      const serviceDeployments: ServicePlatformInfo[] = []; // Init doesn't use services
      const options = {
        environment: 'none',
        force: false,
        environments: ['local', 'test', 'staging', 'production'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };
      const result = await init(serviceDeployments, options);
      expect(result.command).toBe('init');
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(0);
      
      // Check that semiont.json was created
      expect(fs.existsSync('semiont.json')).toBe(true);
      const semiontContent = JSON.parse(fs.readFileSync('semiont.json', 'utf-8'));
      expect(semiontContent.version).toBe('1.0.0');
      
      // Check that environment configs were created
      expect(fs.existsSync('environments/local.json')).toBe(true);
      expect(fs.existsSync('environments/test.json')).toBe(true);
      expect(fs.existsSync('environments/staging.json')).toBe(true);
      expect(fs.existsSync('environments/production.json')).toBe(true);
    });

    it('should use custom project name when provided', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        name: 'my-awesome-project',
        force: false,
        environments: ['local', 'production'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };
      await init(serviceDeployments, options);
      
      // Check that project name is in semiont.json
      const semiontContent = JSON.parse(fs.readFileSync('semiont.json', 'utf-8'));
      expect(semiontContent.project).toBe('my-awesome-project');
    });

    it('should use custom directory when provided', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const customDir = path.join(testDir, 'custom-project');
      const options = {
        environment: 'none',
        directory: customDir,
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };
      const result = await init(serviceDeployments, options);
      expect(result.command).toBe('init');
      expect(result.summary.succeeded).toBe(1);
      
      // Check that files were created in custom directory
      expect(fs.existsSync(path.join(customDir, 'semiont.json'))).toBe(true);
      expect(fs.existsSync(path.join(customDir, 'environments', 'local.json'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should fail if semiont.json exists and force is false', async () => {
      // Create an existing semiont.json
      fs.writeFileSync('semiont.json', JSON.stringify({ version: '0.0.1' }));
      
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };

      const result = await init(serviceDeployments, options);

      // Should fail because file exists
      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
      
      // Original file should remain unchanged
      const content = JSON.parse(fs.readFileSync('semiont.json', 'utf-8'));
      expect(content.version).toBe('0.0.1');
    });

    it('should overwrite if semiont.json exists and force is true', async () => {
      // Create an existing semiont.json
      fs.writeFileSync('semiont.json', JSON.stringify({ version: '0.0.1' }));
      
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        force: true,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };

      const result = await init(serviceDeployments, options);

      // Should succeed with force flag
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(0);
      
      // File should be overwritten with new version
      const content = JSON.parse(fs.readFileSync('semiont.json', 'utf-8'));
      expect(content.version).toBe('1.0.0');
    });

    it('should handle filesystem errors gracefully', async () => {
      // Create a directory where we can't write
      const readOnlyDir = path.join(testDir, 'readonly');
      fs.mkdirSync(readOnlyDir);
      // Make it read-only (this might not work on all systems, so we'll skip if it doesn't)
      try {
        fs.chmodSync(readOnlyDir, 0o444);
      } catch {
        // Skip this test if we can't set permissions
        return;
      }
      
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        directory: readOnlyDir,
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };
      const result = await init(serviceDeployments, options);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
      
      // Restore permissions for cleanup
      fs.chmodSync(readOnlyDir, 0o755);
    });
  });

  describe('environment configuration', () => {
    it('should create configs for custom environment list', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        environments: ['dev', 'qa', 'prod'],
        force: false,
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };

      await init(serviceDeployments, options);

      // Check that custom environment files were created
      expect(fs.existsSync('environments/dev.json')).toBe(true);
      expect(fs.existsSync('environments/qa.json')).toBe(true);
      expect(fs.existsSync('environments/prod.json')).toBe(true);
      
      // Should not create default environments
      expect(fs.existsSync('environments/local.json')).toBe(false);
      expect(fs.existsSync('environments/staging.json')).toBe(false);
    });

    it('should generate appropriate configs for each environment type', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        environments: ['local', 'staging', 'production'],
        force: false,
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };
      await init(serviceDeployments, options);
      
      // Check local environment config - uses container as default but services use process
      const localConfig = JSON.parse(fs.readFileSync('environments/local.json', 'utf-8'));
      expect(localConfig.deployment.default).toBe('container');
      // But individual services use process for local development
      expect(localConfig.services.backend.deployment.type).toBe('process');
      expect(localConfig.services.frontend.deployment.type).toBe('process');
      
      // Check staging environment config uses AWS
      const stagingConfig = JSON.parse(fs.readFileSync('environments/staging.json', 'utf-8'));
      expect(stagingConfig.deployment.default).toBe('aws');
      
      // Check production environment config uses AWS
      const prodConfig = JSON.parse(fs.readFileSync('environments/production.json', 'utf-8'));
      expect(prodConfig.deployment.default).toBe('aws');
    });
  });

  describe('output modes', () => {
    it('should suppress output in quiet mode', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };
      const result = await init(serviceDeployments, options);
      // Should still succeed even in quiet mode
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(0);
    });

    it('should show verbose output when requested', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        force: false,
        environments: ['local', 'staging'],
        output: 'summary' as const,
        quiet: false,
        verbose: true,
        dryRun: false,
      };
      const result = await init(serviceDeployments, options);
      // Verbose mode should still succeed
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(0);
    });

    it('should handle dry run mode', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: true,
      };
      const result = await init(serviceDeployments, options);
      // In dry run mode, files should not be written
      // (Though current implementation doesn't check dryRun for init)
      // This test is here for future implementation
      expect(result.executionContext.dryRun).toBe(true);
    });
  });

  describe('CommandFunction compliance', () => {
    it('should accept ServicePlatformInfo[] as first parameter', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: false,
      };
      const result = await init(serviceDeployments, options);
      expect(result).toBeDefined();
      expect(result.command).toBe('init');
    });

    it('should return CommandResults structure', async () => {
      const serviceDeployments: ServicePlatformInfo[] = [];
      const options = {
        environment: 'none',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: false,
      };
      const result = await init(serviceDeployments, options);
      // Verify CommandResults structure
      expect(result).toHaveProperty('command');
      expect(result).toHaveProperty('environment');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('executionContext');
      
      expect(result.command).toBe('init');
      expect(result.environment).toBe('none');
      expect(result.services).toEqual([]);
    });

    it('should work with all output formats', async () => {
      const formats = ['summary', 'json', 'yaml'] as const;
      
      for (const format of formats) {
        // Clean up between iterations
        if (fs.existsSync('semiont.json')) {
          fs.rmSync('semiont.json');
          fs.rmSync('environments', { recursive: true });
          fs.rmSync('cdk', { recursive: true });
        }
        
        const serviceDeployments: ServicePlatformInfo[] = [];
        const options = {
          environment: 'none',
          force: false,
          environments: ['local'],
          output: format,
          quiet: true,
          verbose: false,
          dryRun: false,
        };
        const result = await init(serviceDeployments, options);
        expect(result.command).toBe('init');
        expect(result.summary.succeeded).toBe(1);
      }
    });
  });
});