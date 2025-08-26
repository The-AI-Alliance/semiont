/**
 * Test Environment Setup Utilities
 * 
 * Creates real Semiont project environments for testing using semiont init
 * instead of mocking the configuration system.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

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
    
    // Initialize Semiont project with test environments
    const envList = environments.join(',');
    execSync(`semiont init --name "semiont-test" --environments "${envList}"`, {
      stdio: 'pipe', // Suppress output during tests
      cwd: projectDir
    });
    
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