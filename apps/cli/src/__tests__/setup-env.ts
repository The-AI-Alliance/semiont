/**
 * Global test setup for CLI
 * Clean, simple approach
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create a temp directory for all tests to use
export const testRootDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'semiont-cli-test-')
);

// Set environment for tests
process.env.SEMIONT_ROOT = testRootDir;
process.env.SEMIONT_ENV = 'test';

// Clean up after all tests
if (typeof afterAll !== 'undefined') {
  afterAll(() => {
    if (testRootDir && testRootDir.startsWith(os.tmpdir())) {
      fs.rmSync(testRootDir, { recursive: true, force: true });
    }
  });
}