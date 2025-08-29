/**
 * CLI Test Environment with lazy initialization
 * 
 * Provides centralized test setup for CLI tests with
 * on-demand initialization and test directory caching
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import type { BaseCommandOptions } from '../commands/base-command-options.js';

interface TestProject {
  directory: string;
  name: string;
  environments: string[];
  initialized: boolean;
}

export class CLITestEnvironment {
  private static instance: CLITestEnvironment | null = null;
  private testProjects: Map<string, TestProject> = new Map();
  private globalTestDir: string | null = null;
  private originalEnv: NodeJS.ProcessEnv;
  private originalCwd: string;
  private isInitialized = false;

  private constructor() {
    // Store original environment and working directory
    this.originalEnv = { ...process.env };
    this.originalCwd = process.cwd();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): CLITestEnvironment {
    if (!this.instance) {
      this.instance = new CLITestEnvironment();
    }
    return this.instance;
  }

  /**
   * Initialize test environment (lazy)
   */
  async initialize(options?: {
    createTestDir?: boolean;
    projectName?: string;
    environments?: string[];
  }) {
    if (this.isInitialized && !options) {
      return;
    }

    const config = {
      createTestDir: true,
      projectName: 'test-project',
      environments: ['local', 'test', 'staging', 'production'],
      ...options
    };

    // Create or get test directory if needed
    if (config.createTestDir) {
      await this.getOrCreateTestDirectory(config.projectName, config.environments);
    }

    this.isInitialized = true;
  }

  /**
   * Get or create a test directory (cached for reuse)
   */
  async getOrCreateTestDirectory(
    projectName: string = 'test-project',
    environments: string[] = ['local', 'test']
  ): Promise<string> {
    // Check if we already have this project
    const projectKey = `${projectName}-${environments.join('-')}`;
    const existing = this.testProjects.get(projectKey);
    
    if (existing && existing.initialized) {
      return existing.directory;
    }

    // Create new test directory
    const testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `semiont-test-${projectName}-`)
    );

    // Store project info
    const project: TestProject = {
      directory: testDir,
      name: projectName,
      environments,
      initialized: false
    };

    this.testProjects.set(projectKey, project);

    // Initialize project if init command is available
    if (await this.shouldInitializeProject()) {
      await this.initializeTestProject(project);
    }

    return testDir;
  }

  /**
   * Check if we should run init command
   */
  private async shouldInitializeProject(): Promise<boolean> {
    try {
      // Check if init command exists
      const initPath = path.join(this.originalCwd, 'commands', 'init.js');
      return fs.existsSync(initPath);
    } catch {
      return false;
    }
  }

  /**
   * Initialize a test project using the init command
   */
  private async initializeTestProject(project: TestProject) {
    const originalCwd = process.cwd();
    
    try {
      // Import init command dynamically
      const initModule = await import('../commands/init.js');
      const init = initModule.init;
      
      if (!init) {
        console.warn('Init command not found, skipping initialization');
        return;
      }

      // Change to test directory
      process.chdir(project.directory);

      // Run init command
      const options: BaseCommandOptions & any = {
        name: project.name,
        directory: project.directory,
        force: false,
        environments: project.environments,
        environment: 'local',
        output: 'summary',
        quiet: true,
        verbose: false
      };

      await init(options);

      // Mark as initialized
      project.initialized = true;

      // Set SEMIONT_ROOT for deployment resolver
      process.env.SEMIONT_ROOT = project.directory;

    } catch (error) {
      console.warn('Failed to initialize test project:', error);
    } finally {
      // Restore working directory
      process.chdir(originalCwd);
    }
  }

  /**
   * Get a fresh temporary directory (not cached)
   */
  createTempDirectory(prefix: string = 'semiont-temp'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  }

  /**
   * Create a test file in a directory
   */
  createTestFile(dir: string, filename: string, content: string): string {
    const filePath = path.join(dir, filename);
    const fileDir = path.dirname(filePath);
    
    // Ensure directory exists
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /**
   * Create a test configuration file
   */
  createConfigFile(dir: string, config: any): string {
    return this.createTestFile(
      dir,
      'semiont.json',
      JSON.stringify(config, null, 2)
    );
  }

  /**
   * Get global test directory
   */
  getGlobalTestDirectory(): string | null {
    return this.globalTestDir;
  }

  /**
   * Set environment variable
   */
  setEnvVar(key: string, value: string) {
    process.env[key] = value;
  }

  /**
   * Set multiple environment variables
   */
  setEnvVars(vars: Record<string, string>) {
    Object.assign(process.env, vars);
  }

  /**
   * Change working directory temporarily
   */
  changeDirectory(dir: string) {
    process.chdir(dir);
  }

  /**
   * Restore original working directory
   */
  restoreDirectory() {
    process.chdir(this.originalCwd);
  }

  /**
   * Mock a CLI command
   */
  mockCommand(commandName: string, handler: any) {
    const commandPath = `../commands/${commandName}.js`;
    vi.doMock(commandPath, () => ({
      default: {
        handler,
        name: commandName,
        description: `Mocked ${commandName} command`
      }
    }));
  }

  /**
   * Reset mocks but keep test directories
   */
  resetMocks() {
    vi.clearAllMocks();
    // Don't delete test directories - they can be reused
  }

  /**
   * Clean up a specific test directory
   */
  cleanupTestDirectory(dir: string) {
    if (dir && dir.startsWith(os.tmpdir())) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Failed to clean up test directory ${dir}:`, error);
      }
    }
  }

  /**
   * Full reset - restore original environment and clean up
   */
  async reset() {
    // Restore original environment
    process.env = { ...this.originalEnv };
    
    // Restore original working directory
    process.chdir(this.originalCwd);

    // Clean up all test directories
    for (const project of this.testProjects.values()) {
      this.cleanupTestDirectory(project.directory);
    }
    this.testProjects.clear();

    // Clean up global test directory
    if (this.globalTestDir) {
      this.cleanupTestDirectory(this.globalTestDir);
      this.globalTestDir = null;
    }

    // Clear all mocks
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    this.isInitialized = false;
  }

  /**
   * Clean up (for afterAll)
   */
  async cleanup() {
    await this.reset();
    CLITestEnvironment.instance = null;
  }

  /**
   * Get statistics about test directories
   */
  getStats() {
    return {
      testProjects: this.testProjects.size,
      initialized: this.isInitialized,
      cachedDirectories: Array.from(this.testProjects.values()).map(p => ({
        name: p.name,
        directory: p.directory,
        initialized: p.initialized
      }))
    };
  }
}

/**
 * Convenience function for quick setup
 */
export async function setupCLITest(options?: Parameters<CLITestEnvironment['initialize']>[0]) {
  const env = CLITestEnvironment.getInstance();
  await env.initialize(options);
  return env;
}

/**
 * Helper to run a CLI command in a test environment
 */
export async function runInTestEnvironment<T>(
  fn: (env: CLITestEnvironment) => Promise<T>,
  options?: Parameters<CLITestEnvironment['initialize']>[0]
): Promise<T> {
  const env = await setupCLITest(options);
  try {
    return await fn(env);
  } finally {
    env.restoreDirectory();
  }
}