/**
 * Integration tests for the init command
 * Uses real filesystem with temporary directories
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { init, type InitOptions } from '../init';

// Mock readline so prompt() resolves immediately without blocking stdin
vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (a: string) => void) => cb('test-user')),
    close: vi.fn(),
  })),
}));

// Helper to create complete InitOptions with defaults
function createInitOptions(partial: Partial<InitOptions> = {}): InitOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'summary',
    forceDiscovery: false,
    preflight: false,
    force: false,
    noGit: false,
    environments: ['local', 'test', 'staging', 'production'],
    name: undefined,
    directory: undefined,
    ...partial
  };
}

describe('init command', () => {
  let testDir: string;
  let fakeHome: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-init-test-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-init-home-'));
    process.chdir(testDir);
    process.env.HOME = fakeHome;

    const testFilePath = fileURLToPath(import.meta.url);
    const testFileDir = path.dirname(testFilePath);
    process.env.SEMIONT_TEMPLATES_DIR = path.join(testFileDir, '..', '..', '..', '..', 'templates');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    delete process.env.SEMIONT_TEMPLATES_DIR;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (fs.existsSync(fakeHome)) {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  describe('basic functionality', () => {
    it('should initialize a project with default settings', async () => {
      const result = await init(createInitOptions({ quiet: true }));
      expect(result.command).toBe('init');
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(0);

      // .semiont/config (TOML) is the new project anchor
      expect(fs.existsSync('.semiont/config')).toBe(true);
      const config = fs.readFileSync('.semiont/config', 'utf-8');
      expect(config).toContain('[project]');

      // Old semiont.json and environments/ should NOT be created
      expect(fs.existsSync('semiont.json')).toBe(false);
      expect(fs.existsSync('environments')).toBe(false);
    });

    it('should embed project name in .semiont/config', async () => {
      await init(createInitOptions({ name: 'my-awesome-project', quiet: true }));

      const config = fs.readFileSync('.semiont/config', 'utf-8');
      expect(config).toContain('my-awesome-project');
    });

    it('should use custom directory when provided', async () => {
      const customDir = path.join(testDir, 'custom-project');
      const result = await init(createInitOptions({ directory: customDir, quiet: true }));
      expect(result.summary.succeeded).toBe(1);

      expect(fs.existsSync(path.join(customDir, '.semiont', 'config'))).toBe(true);
      expect(fs.existsSync(path.join(customDir, 'semiont.json'))).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should fail if .semiont/ already exists and force is false', async () => {
      // Pre-create .semiont/
      fs.mkdirSync('.semiont', { recursive: true });
      fs.writeFileSync('.semiont/config', '[project]\nname = "existing"\n');

      const result = await init(createInitOptions({ quiet: true }));
      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);

      // Original config should be unchanged
      const config = fs.readFileSync('.semiont/config', 'utf-8');
      expect(config).toContain('existing');
    });

    it('should overwrite if .semiont/ exists and force is true', async () => {
      fs.mkdirSync('.semiont', { recursive: true });
      fs.writeFileSync('.semiont/config', '[project]\nname = "existing"\n');

      const result = await init(createInitOptions({ name: 'new-name', force: true, quiet: true }));
      expect(result.summary.succeeded).toBe(1);

      const config = fs.readFileSync('.semiont/config', 'utf-8');
      expect(config).toContain('new-name');
    });

    it('should handle filesystem errors gracefully', async () => {
      const readOnlyDir = path.join(testDir, 'readonly');
      fs.mkdirSync(readOnlyDir);
      try {
        fs.chmodSync(readOnlyDir, 0o444);
      } catch {
        return; // Skip if we can't set permissions
      }

      const result = await init(createInitOptions({ directory: readOnlyDir, quiet: true }));
      expect(result.summary.failed).toBe(1);

      fs.chmodSync(readOnlyDir, 0o755);
    });
  });

  describe('output modes', () => {
    it('should suppress output in quiet mode', async () => {
      const result = await init(createInitOptions({ quiet: true }));
      expect(result.summary.succeeded).toBe(1);
    });

    it('should handle dry run mode', async () => {
      const result = await init(createInitOptions({ dryRun: true }));
      expect(result.executionContext.dryRun).toBe(true);
      // In dry run, .semiont/ should not be created
      expect(fs.existsSync('.semiont')).toBe(false);
    });
  });

  describe('global config (~/.semiontconfig)', () => {
    it('should create ~/.semiontconfig when it does not exist', async () => {
      const globalConfigPath = path.join(fakeHome, '.semiontconfig');
      expect(fs.existsSync(globalConfigPath)).toBe(false);

      await init(createInitOptions({ quiet: true }));

      expect(fs.existsSync(globalConfigPath)).toBe(true);
      const content = fs.readFileSync(globalConfigPath, 'utf-8');
      expect(content).toContain('[user]');
      expect(content).toContain('[defaults]');
      expect(content).toContain('[environments.local.backend]');
    });

    it('should not overwrite ~/.semiontconfig when it already exists', async () => {
      const globalConfigPath = path.join(fakeHome, '.semiontconfig');
      const existing = '[user]\nname = "existing-user"\nemail = "existing@example.com"\n';
      fs.writeFileSync(globalConfigPath, existing, 'utf-8');

      await init(createInitOptions({ quiet: true }));

      const content = fs.readFileSync(globalConfigPath, 'utf-8');
      expect(content).toBe(existing);
    });
  });

  describe('CommandFunction compliance', () => {
    it('should return CommandResults structure', async () => {
      const result = await init(createInitOptions({ quiet: true }));
      expect(result).toHaveProperty('command');
      expect(result).toHaveProperty('environment');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('executionContext');

      expect(result.command).toBe('init');
      expect(result.environment).toBe('none');
      expect(result.results).toEqual([]);
    });

    it('should work with all output formats', async () => {
      const formats = ['summary', 'json', 'yaml'] as const;

      for (const format of formats) {
        if (fs.existsSync('.semiont')) {
          fs.rmSync('.semiont', { recursive: true });
          fs.rmSync('cdk', { recursive: true, force: true });
        }

        const result = await init(createInitOptions({ output: format, quiet: true }));
        expect(result.command).toBe('init');
        expect(result.summary.succeeded).toBe(1);
      }
    });
  });
});
