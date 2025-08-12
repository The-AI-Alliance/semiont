/**
 * Unit tests for the init command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { init } from '../commands/init';
import { CommandResults } from '../lib/command-results';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      mkdir: vi.fn(),
    },
  },
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock path module
vi.mock('path', () => ({
  default: {
    join: vi.fn((...args) => args.join('/')),
    basename: vi.fn((p) => p.split('/').pop() || 'project'),
  },
  join: vi.fn((...args) => args.join('/')),
  basename: vi.fn((p) => p.split('/').pop() || 'project'),
}));

describe('init command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    (fs.existsSync as any).mockReturnValue(false);
    (fs.mkdirSync as any).mockReturnValue(undefined);
    (fs.writeFileSync as any).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should initialize a project with default settings', async () => {
      const options = {
        force: false,
        environments: ['local', 'test', 'staging', 'production'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result.command).toBe('init');
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(0);
      
      // Check that semiont.json was created
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('semiont.json'),
        expect.stringContaining('"version": "1.0"')
      );

      // Check that environment configs were created
      expect(fs.writeFileSync).toHaveBeenCalledTimes(5); // semiont.json + 4 environments
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments'),
        { recursive: true }
      );
    });

    it('should use custom project name when provided', async () => {
      const options = {
        name: 'my-awesome-project',
        force: false,
        environments: ['local', 'production'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result.metadata?.projectName).toBe('my-awesome-project');
      
      // Check that project name is in semiont.json
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('semiont.json'),
        expect.stringContaining('"project": "my-awesome-project"')
      );
    });

    it('should use custom directory when provided', async () => {
      const options = {
        directory: '/custom/path',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result.metadata?.targetDirectory).toBe('/custom/path');
      
      // Check that files are created in custom directory
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/custom/path/semiont.json',
        expect.any(String)
      );
    });
  });

  describe('environment generation', () => {
    it('should generate correct local environment config', async () => {
      const options = {
        environments: ['local'],
        force: false,
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      await init(options);

      // Find the call that created local.json
      const localConfigCall = (fs.writeFileSync as any).mock.calls.find(
        (call: any[]) => call[0].includes('local.json')
      );

      expect(localConfigCall).toBeDefined();
      const localConfig = JSON.parse(localConfigCall[1]);
      
      expect(localConfig.deployment.default).toBe('process');
      expect(localConfig.env.NODE_ENV).toBe('development');
      expect(localConfig.services.database.deployment.type).toBe('container');
      expect(localConfig.services.filesystem).toBeDefined();
      expect(localConfig.services.filesystem.path).toBe('./data');
    });

    it('should generate correct production environment config', async () => {
      const options = {
        environments: ['production'],
        force: false,
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      await init(options);

      // Find the call that created production.json
      const prodConfigCall = (fs.writeFileSync as any).mock.calls.find(
        (call: any[]) => call[0].includes('production.json')
      );

      expect(prodConfigCall).toBeDefined();
      const prodConfig = JSON.parse(prodConfigCall[1]);
      
      expect(prodConfig.deployment.default).toBe('aws');
      expect(prodConfig.env.NODE_ENV).toBe('production');
      expect(prodConfig.aws).toBeDefined();
      expect(prodConfig.aws.ecs.desiredCount).toBe(2);
      expect(prodConfig.aws.database.multiAZ).toBe(true);
      expect(prodConfig.services.filesystem).toBeDefined();
      expect(prodConfig.services.filesystem.deployment.type).toBe('aws');
      expect(prodConfig.services.filesystem.path).toBe('/mnt/efs/production');
    });

    it('should generate correct test environment config', async () => {
      const options = {
        environments: ['test'],
        force: false,
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      await init(options);

      // Find the call that created test.json
      const testConfigCall = (fs.writeFileSync as any).mock.calls.find(
        (call: any[]) => call[0].includes('test.json')
      );

      expect(testConfigCall).toBeDefined();
      const testConfig = JSON.parse(testConfigCall[1]);
      
      expect(testConfig.deployment.default).toBe('mock');
      expect(testConfig.env.NODE_ENV).toBe('test');
      expect(testConfig.services.database.deployment.type).toBe('mock');
    });

    it('should handle custom environment names', async () => {
      const options = {
        environments: ['custom-env'],
        force: false,
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      await init(options);

      // Find the call that created custom-env.json
      const customConfigCall = (fs.writeFileSync as any).mock.calls.find(
        (call: any[]) => call[0].includes('custom-env.json')
      );

      expect(customConfigCall).toBeDefined();
      const customConfig = JSON.parse(customConfigCall[1]);
      
      expect(customConfig._comment).toBe('Custom environment: custom-env');
      expect(customConfig.deployment.default).toBe('container');
    });
  });

  describe('error handling', () => {
    it('should fail if semiont.json exists without force flag', async () => {
      (fs.existsSync as any).mockReturnValue(true);

      const options = {
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result.summary.failed).toBe(1);
      expect(result.metadata?.error).toContain('already exists');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should succeed with force flag even if semiont.json exists', async () => {
      (fs.existsSync as any).mockReturnValue(true);

      const options = {
        force: true,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result.summary.succeeded).toBe(1);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should handle file system errors gracefully', async () => {
      (fs.writeFileSync as any).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const options = {
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result.summary.failed).toBe(1);
      expect(result.metadata?.error).toContain('Permission denied');
    });
  });

  describe('semiont.json generation', () => {
    it('should generate valid semiont.json structure', async () => {
      const options = {
        name: 'test-project',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      await init(options);

      // Find the semiont.json creation call
      const semiontJsonCall = (fs.writeFileSync as any).mock.calls.find(
        (call: any[]) => call[0].includes('semiont.json')
      );

      expect(semiontJsonCall).toBeDefined();
      const semiontJson = JSON.parse(semiontJsonCall[1]);

      // Check structure
      expect(semiontJson.version).toBe('1.0');
      expect(semiontJson.project).toBe('test-project');
      expect(semiontJson.site).toBeDefined();
      expect(semiontJson.site.siteName).toBe('test-project');
      expect(semiontJson.site.domain).toBe('test-project.example.com');
      expect(semiontJson.site.adminEmail).toBe('admin@example.com');
      expect(semiontJson.defaults).toBeDefined();
      expect(semiontJson.defaults.deployment.type).toBe('container');
      expect(semiontJson.defaults.services.frontend.port).toBe(3000);
      expect(semiontJson.defaults.services.backend.port).toBe(3001);
      expect(semiontJson.defaults.services.database.port).toBe(5432);
      // Filesystem should NOT be in defaults - it's environment-specific
      expect(semiontJson.defaults.services.filesystem).toBeUndefined();
    });
  });

  describe('output formats', () => {
    it('should return JSON format when requested', async () => {
      const options = {
        force: false,
        environments: ['local'],
        output: 'json' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result).toBeDefined();
      expect(result.command).toBe('init');
      expect(typeof result.duration).toBe('number');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should return YAML format when requested', async () => {
      const options = {
        force: false,
        environments: ['local'],
        output: 'yaml' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      expect(result).toBeDefined();
      expect(result.command).toBe('init');
    });

    it('should handle quiet mode', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      const options = {
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
      };

      const result = await init(options);

      // In quiet mode, no console output during execution
      // (Note: The actual output formatting happens in main(), not in init())
      expect(result.summary.succeeded).toBe(1);
      
      consoleSpy.mockRestore();
    });
  });

  describe('integration with file system', () => {
    it('should create all expected files and directories', async () => {
      const options = {
        name: 'full-test',
        environments: ['local', 'test', 'staging', 'production'],
        force: false,
        output: 'summary' as const,
        quiet: false,
        verbose: false,
      };

      const result = await init(options);

      // Check metadata for created files
      expect(result.metadata?.createdFiles).toContain('semiont.json');
      expect(result.metadata?.createdFiles).toContain('config/environments/local.json');
      expect(result.metadata?.createdFiles).toContain('config/environments/test.json');
      expect(result.metadata?.createdFiles).toContain('config/environments/staging.json');
      expect(result.metadata?.createdFiles).toContain('config/environments/production.json');

      // Verify directory creation
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments'),
        { recursive: true }
      );

      // Verify all files were written
      expect(fs.writeFileSync).toHaveBeenCalledTimes(5);
    });
  });
});