/**
 * Environment Validator - Check system requirements for installation
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ProgressReporter } from './progress-reporter.js';

export class EnvironmentValidator {
  private projectRoot: string;
  private reporter: ProgressReporter;

  constructor(projectRoot: string, reporter: ProgressReporter) {
    this.projectRoot = projectRoot;
    this.reporter = reporter;
  }

  async validate(): Promise<void> {
    this.reporter.showVerbose('Starting environment validation...');
    
    // Check if we're in the right directory
    await this.validateProjectDirectory();
    
    // Check for Node.js
    await this.validateNodeJs();
    
    this.reporter.showVerbose('Environment validation complete');
  }

  private async validateProjectDirectory(): Promise<void> {
    const packageJsonPath = path.join(this.projectRoot, 'package.json');
    const cliPackagePath = path.join(this.projectRoot, 'packages', 'cli', 'package.json');
    
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error('Must run from Semiont project root - package.json not found');
    }
    
    if (!fs.existsSync(cliPackagePath)) {
      throw new Error('CLI package not found - invalid project structure');
    }
    
    this.reporter.showVerbose('✓ Project directory structure validated');
  }

  private async validateNodeJs(): Promise<void> {
    // Check if Node.js is available
    try {
      const version = await this.getNodeVersion();
      const majorVersion = parseInt(version.split('.')[0]);
      
      if (majorVersion < 18) {
        this.reporter.showWarning(`Node.js v18+ recommended (found v${version})`);
      } else {
        this.reporter.showVerbose(`✓ Node.js v${version} detected`);
      }
    } catch (error) {
      throw new Error('Node.js is not installed or not accessible');
    }
  }

  private getNodeVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['-v'], { stdio: 'pipe' });
      
      let output = '';
      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      proc.on('exit', (code) => {
        if (code === 0) {
          // Remove 'v' prefix and trim
          const version = output.trim().replace(/^v/, '');
          resolve(version);
        } else {
          reject(new Error('Failed to get Node.js version'));
        }
      });
      
      proc.on('error', (error) => {
        reject(error);
      });
    });
  }
}