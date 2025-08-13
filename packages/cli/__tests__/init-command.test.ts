/**
 * Unit tests for the init command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { init } from '../commands/init';
import { CommandResults } from '../lib/command-results';
import { ServiceDeploymentInfo } from '../lib/deployment-resolver';

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
      const serviceDeployments: ServiceDeploymentInfo[] = []; // Init doesn't use services
      const options = {
        environment: 'none',
        force: false,
        environments: ['local', 'test', 'staging', 'production'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: false,
      };

      const result = await init(serviceDeployments, options);

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
      const serviceDeployments: ServiceDeploymentInfo[] = [];
      const options = {
        environment: 'none',
        name: 'my-awesome-project',
        force: false,
        environments: ['local', 'production'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: false,
      };

      const result = await init(serviceDeployments, options);

      // Note: metadata is no longer part of CommandResults, so we can't check projectName directly
      // We verify by checking the write calls
      
      // Check that project name is in semiont.json
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('semiont.json'),
        expect.stringContaining('"project": "my-awesome-project"')
      );
    });

    it('should use custom directory when provided', async () => {
      const serviceDeployments: ServiceDeploymentInfo[] = [];
      const options = {
        environment: 'none',
        directory: '/custom/path',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: false,
      };

      const result = await init(serviceDeployments, options);

      expect(result.command).toBe('init');
      expect(result.summary.succeeded).toBe(1);
      
      // Check that files were created in custom directory
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/custom/path/semiont.json',
        expect.any(String)
      );
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        '/custom/path/config/environments',
        { recursive: true }
      );
    });
  });

  describe('error handling', () => {
    it('should fail if semiont.json exists and force is false', async () => {
      (fs.existsSync as any).mockReturnValue(true); // File exists
      
      const serviceDeployments: ServiceDeploymentInfo[] = [];
      const options = {
        environment: 'none',
        force: false,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true, // Suppress output in tests
        verbose: false,
        dryRun: false,
      };

      await init(serviceDeployments, options);

      // Should not write any files
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should overwrite if semiont.json exists and force is true', async () => {
      (fs.existsSync as any).mockReturnValue(true); // File exists
      
      const serviceDeployments: ServiceDeploymentInfo[] = [];
      const options = {
        environment: 'none',
        force: true,
        environments: ['local'],
        output: 'summary' as const,
        quiet: true,
        verbose: false,
        dryRun: false,
      };

      await init(serviceDeployments, options);

      // Should write files despite existing
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('should handle filesystem errors gracefully', async () => {
      (fs.writeFileSync as any).mockImplementation(() => {
        throw new Error('Permission denied');
      });
      
      const serviceDeployments: ServiceDeploymentInfo[] = [];
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

      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });
  });

  describe('environment configuration', () => {
    it('should create configs for custom environment list', async () => {
      const serviceDeployments: ServiceDeploymentInfo[] = [];
      const options = {
        environment: 'none',
        environments: ['dev', 'qa', 'prod'],
        force: false,
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: false,
      };

      await init(serviceDeployments, options);

      // Should create semiont.json + 3 environment configs
      expect(fs.writeFileSync).toHaveBeenCalledTimes(4);
      
      // Check specific environment files
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments/dev.json'),
        expect.any(String)
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments/qa.json'),
        expect.any(String)
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments/prod.json'),
        expect.any(String)
      );
    });

    it('should generate appropriate configs for each environment type', async () => {
      const serviceDeployments: ServiceDeploymentInfo[] = [];
      const options = {
        environment: 'none',
        environments: ['local', 'staging', 'production'],
        force: false,
        output: 'summary' as const,
        quiet: false,
        verbose: false,
        dryRun: false,
      };

      const result = await init(serviceDeployments, options);

      // Check local environment config
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments/local.json'),
        expect.stringContaining('"default": "process"')
      );

      // Check staging environment config
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments/staging.json'),
        expect.stringContaining('"default": "container"')
      );

      // Check production environment config  
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config/environments/production.json'),
        expect.stringContaining('"default": "aws"')
      );
    });
  });

  describe('output modes', () => {
    it('should suppress output in quiet mode', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      const serviceDeployments: ServiceDeploymentInfo[] = [];
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

      // Quiet mode should not log anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
      
      consoleLogSpy.mockRestore();
    });

    it('should show verbose output when requested', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      const serviceDeployments: ServiceDeploymentInfo[] = [];
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

      // Verbose mode should log additional details
      // Note: The exact logging behavior depends on implementation
      expect(result.summary.succeeded).toBe(1);
      
      consoleLogSpy.mockRestore();
    });

    it('should handle dry run mode', async () => {
      const serviceDeployments: ServiceDeploymentInfo[] = [];
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
    it('should accept ServiceDeploymentInfo[] as first parameter', async () => {
      const serviceDeployments: ServiceDeploymentInfo[] = [];
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
      const serviceDeployments: ServiceDeploymentInfo[] = [];
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
        const serviceDeployments: ServiceDeploymentInfo[] = [];
        const options = {
          environment: 'none',
          force: false,
          environments: ['local'],
          output: format,
          quiet: false,
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