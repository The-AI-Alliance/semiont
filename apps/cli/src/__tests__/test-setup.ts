/**
 * Test Environment Setup Utilities
 * 
 * Creates real Semiont project environments for testing using the init command
 * handler directly, simulating what happens when a user runs 'semiont init'.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, afterAll } from 'vitest';
import { initCommand } from '../commands/init.js';

export interface TestEnvironment {
  projectDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Sets up a temporary Semiont project for testing
 */
export async function setupTestProject(environments: string[] = ['local', 'staging', 'production', 'test']): Promise<TestEnvironment> {
  const originalCwd = process.cwd();
  
  // Create temporary directory
  const projectDir = await mkdtemp(join(tmpdir(), 'semiont-test-'));
  
  try {
    // Change to test directory
    process.chdir(projectDir);
    
    // Call the init command handler directly, simulating what the CLI would do
    const init = initCommand.handler;
    // init is a SetupCommandFunction, it only expects options
    const options = {
      environment: 'none',
      name: 'semiont-test',
      environments: environments,
      force: false,
      quiet: true,
      verbose: false,
      dryRun: false,
      output: 'summary' as const
    };
    
    await init(options);
    
    // Return to original directory
    process.chdir(originalCwd);
    
    return {
      projectDir,
      cleanup: async () => {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    // Ensure we return to original directory on error
    process.chdir(originalCwd);
    await rm(projectDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Test setup hook for suites that need a Semiont project
 */
export function useSemiontProject(environments?: string[]) {
  let testEnv: TestEnvironment;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    testEnv = await setupTestProject(environments);
    process.chdir(testEnv.projectDir);
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
    if (originalCwd) {
      process.chdir(originalCwd);
    }
  });

  return {
    getProjectDir: () => testEnv?.projectDir,
    getCwd: () => process.cwd()
  };
}