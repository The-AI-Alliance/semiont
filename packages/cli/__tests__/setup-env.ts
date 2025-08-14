/**
 * Global test setup that runs before all tests
 * 
 * Creates a test environment using the actual init command
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { beforeAll, afterAll } from 'vitest';
import initCommand from '../commands/init.js';
const init = initCommand.handler;

// Global test directory that will be used by all tests
let globalTestDir: string;

beforeAll(async () => {
  // Create a global test directory for all tests
  globalTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-test-global-'));
  
  // Change to the test directory for init
  const originalCwd = process.cwd();
  process.chdir(globalTestDir);
  
  try {
    // Use the actual init command to create proper configs
    await init([], {
      name: 'test-project',
      directory: globalTestDir,
      force: false,
      environments: ['local', 'test', 'staging', 'production'],
      environment: 'local',  // Required by BaseCommandOptions
      output: 'summary',
      quiet: true,  // Suppress output during test setup
      verbose: false
    });
    
    // Set as SEMIONT_ROOT so deployment-resolver can find it
    process.env.SEMIONT_ROOT = globalTestDir;
    
  } finally {
    // Restore original working directory
    process.chdir(originalCwd);
  }
});

afterAll(() => {
  // Clean up the global test directory
  if (globalTestDir && globalTestDir.startsWith(os.tmpdir())) {
    fs.rmSync(globalTestDir, { recursive: true, force: true });
  }
  
  // Clean up environment variable
  delete process.env.SEMIONT_ROOT;
});

// Export the test directory for use in tests if needed
export { globalTestDir };