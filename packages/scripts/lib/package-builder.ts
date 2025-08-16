/**
 * Package Builder - Build individual packages with proper error handling
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { ProgressReporter } from './progress-reporter.js';

export interface BuildResult {
  success: boolean;
  packageName: string;
  buildTime: number;
  output?: string;
  error?: string;
}

export class PackageBuilder {
  private projectRoot: string;
  private reporter: ProgressReporter;

  constructor(projectRoot: string, reporter: ProgressReporter) {
    this.projectRoot = projectRoot;
    this.reporter = reporter;
  }

  async buildPackage(packagePath: string, packageName: string): Promise<BuildResult> {
    const startTime = Date.now();
    const fullPath = path.join(this.projectRoot, packagePath);
    
    this.reporter.showVerbose(`Building ${packageName} at ${packagePath}`);
    
    if (!fs.existsSync(fullPath)) {
      this.reporter.showWarning(`${packageName} not found, skipping`);
      return {
        success: true,
        packageName,
        buildTime: Date.now() - startTime,
        output: 'Package not found, skipped'
      };
    }

    try {
      // Check if build script exists (dependencies already installed)
      const packageJsonPath = path.join(fullPath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (packageJson.scripts?.build) {
          // Run build
          await this.runNpmCommand(fullPath, ['run', 'build', '--silent']);
        } else {
          this.reporter.showVerbose(`${packageName} has no build script, skipping build`);
        }
      }
      
      const buildTime = Date.now() - startTime;
      this.reporter.showSuccess(`${packageName} built (${buildTime}ms)`);
      
      return {
        success: true,
        packageName,
        buildTime,
        output: 'Build successful'
      };
      
    } catch (error) {
      const buildTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.reporter.showWarning(`${packageName} build failed: ${errorMessage}`);
      
      return {
        success: false,
        packageName,
        buildTime,
        error: errorMessage
      };
    }
  }

  async linkCliGlobally(): Promise<BuildResult> {
    const startTime = Date.now();
    const cliPath = path.join(this.projectRoot, 'apps', 'cli');
    
    this.reporter.showVerbose('Linking CLI globally...');
    
    try {
      // Check if already linked and unlink
      try {
        await this.runNpmCommand(cliPath, ['unlink', '-g'], true); // Allow failure
      } catch (error) {
        this.reporter.showVerbose(`Unlink failed (expected if not previously linked): ${error}`);
      }
      
      // Link globally
      try {
        await this.runNpmCommand(cliPath, ['link']);
      } catch (error) {
        // If linking fails due to existing installation, suggest force option
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('EEXIST') || errorMessage.includes('file already exists')) {
          this.reporter.showWarning('CLI already installed globally. Attempting force installation...');
          try {
            await this.runNpmCommand(cliPath, ['link', '--force']);
          } catch (forceError) {
            throw new Error('Failed to install CLI globally. Try manually running: npm unlink -g @semiont/cli && npm link --force');
          }
        } else {
          throw error;
        }
      }
      
      const buildTime = Date.now() - startTime;
      this.reporter.showSuccess(`CLI linked globally (${buildTime}ms)`);
      
      return {
        success: true,
        packageName: 'semiont CLI',
        buildTime,
        output: 'CLI linked successfully'
      };
      
    } catch (error) {
      const buildTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        success: false,
        packageName: 'semiont CLI',
        buildTime,
        error: errorMessage
      };
    }
  }

  private runNpmCommand(cwd: string, args: string[], allowFailure: boolean = false): Promise<string> {
    return new Promise((resolve, reject) => {
      this.reporter.showVerbose(`Running: npm ${args.join(' ')} in ${cwd}`);
      
      const proc = spawn('npm', args, {
        cwd,
        stdio: 'pipe'
      });
      
      let output = '';
      let error = '';
      
      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      proc.stderr?.on('data', (data) => {
        error += data.toString();
      });
      
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          if (allowFailure) {
            resolve(output);
          } else {
            reject(new Error(`Command failed with code ${code}: ${error || output}`));
          }
        }
      });
      
      proc.on('error', (err) => {
        if (allowFailure) {
          resolve('');
        } else {
          reject(err);
        }
      });
    });
  }
}