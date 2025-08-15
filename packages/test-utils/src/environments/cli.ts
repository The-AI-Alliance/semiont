/**
 * CLI Test Environment
 * Simple, direct approach for CLI testing
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class CLITestEnvironment {
  private static testDirs: string[] = [];

  /**
   * Create a test directory
   */
  static createTestDir(prefix = 'semiont-test'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    this.testDirs.push(dir);
    return dir;
  }

  /**
   * Setup environment variables
   */
  static setupEnvironment(testDir?: string) {
    if (testDir) {
      process.env.SEMIONT_ROOT = testDir;
    }
    process.env.SEMIONT_ENV = 'test';
  }

  /**
   * Create a test file
   */
  static createFile(dir: string, filename: string, content: string): string {
    const filePath = path.join(dir, filename);
    const fileDir = path.dirname(filePath);
    
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /**
   * Create a semiont.json config
   */
  static createConfig(dir: string, config: any): string {
    return this.createFile(
      dir,
      'semiont.json',
      JSON.stringify(config, null, 2)
    );
  }

  /**
   * Clean up all test directories
   */
  static cleanup() {
    for (const dir of this.testDirs) {
      if (dir && dir.startsWith(os.tmpdir())) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          console.warn(`Failed to clean up ${dir}:`, error);
        }
      }
    }
    this.testDirs = [];
  }

  /**
   * Run function in a test directory
   */
  static async inTestDir<T>(
    fn: (dir: string) => T | Promise<T>
  ): Promise<T> {
    const dir = this.createTestDir();
    const originalCwd = process.cwd();
    
    try {
      process.chdir(dir);
      return await fn(dir);
    } finally {
      process.chdir(originalCwd);
    }
  }
}