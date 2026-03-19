/**
 * Global test setup for CLI
 * Clean, simple approach
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll } from 'vitest';

// Create a temp directory for all tests to use
export const testRootDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'semiont-cli-test-')
);

// Create .semiont/ anchor so findProjectRoot() can discover it via upward walk
fs.mkdirSync(path.join(testRootDir, '.semiont'), { recursive: true });

process.env.SEMIONT_ENV = 'test';
process.chdir(testRootDir);

// Clean up after all tests
if (typeof afterAll !== 'undefined') {
  afterAll(() => {
    process.chdir(path.join(testRootDir, '..'));
    if (testRootDir && testRootDir.startsWith(os.tmpdir())) {
      fs.rmSync(testRootDir, { recursive: true, force: true });
    }
  });
}