/**
 * Test setup utilities for Semiont CLI tests
 *
 * Provides helpers for creating properly initialized test environments
 * with .semiont/config (TOML) and ~/.semiontconfig.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { initCommand } from '../core/commands/init.js';

const init = initCommand.handler;

/**
 * Creates a temporary test directory with initialized Semiont project
 * @param prefix - Prefix for the temp directory name
 * @param projectName - Optional project name for init
 * @returns Path to the created test directory
 */
export async function createTestEnvironment(
  prefix: string = 'semiont-test',
  projectName: string = 'test-project'
): Promise<string> {
  // Create temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  
  // Save current directory
  const originalCwd = process.cwd();
  
  // Set the templates directory for tests to use the built templates
  const testFilePath = fileURLToPath(import.meta.url);
  const testFileDir = path.dirname(testFilePath);
  process.env.SEMIONT_TEMPLATES_DIR = path.join(testFileDir, '..', '..', 'dist', 'templates');
  
  try {
    // Change to temp directory for init
    process.chdir(tmpDir);
    
    // Initialize Semiont project using the actual init command
    try {
      // init is a SetupCommandFunction, it only expects options
      const options = {
        name: projectName,
        directory: tmpDir,
        force: false,
        environments: ['local', 'test', 'staging', 'production', 'remote'],
        environment: 'none',  // init doesn't need an environment
        output: 'summary' as const,
        quiet: true,  // Suppress output during test setup
        verbose: false,
        dryRun: false
      };
      const result = await (init as (options: any) => Promise<any>)(options);
      
      // Check if init failed
      if (result && result.summary && result.summary.failed > 0) {
        console.error('Init command had failures:', result);
        throw new Error('Init command failed to create environment');
      }
    } catch (error) {
      console.error('Init failed in createTestEnvironment:', error);
      throw error;
    }
    
  } finally {
    // Restore original directory
    process.chdir(originalCwd);
  }
  
  return tmpDir;
}

/**
 * Writes test configuration files to a directory.
 * Creates .semiont/config (TOML) as the project anchor.
 * The environments parameter is kept for call-site compatibility but is ignored —
 * environment config now lives in ~/.semiontconfig, not committed files.
 * @param dir - Directory to write configs to
 * @param _environments - Ignored; kept for compatibility
 */
export function writeTestConfigs(
  dir: string,
  _environments: string[] = []
): void {
  const projectName = path.basename(dir);
  const dotSemiontDir = path.join(dir, '.semiont');
  fs.mkdirSync(dotSemiontDir, { recursive: true });
  fs.writeFileSync(
    path.join(dotSemiontDir, 'config'),
    `[project]\nname = "${projectName}"\n`
  );
}

/**
 * Cleans up a test directory
 * @param dir - Directory to clean up
 */
export function cleanupTestEnvironment(dir: string): void {
  if (dir.startsWith(os.tmpdir())) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

