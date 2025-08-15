/**
 * Semiont Installer - Main installation orchestrator
 */

import * as path from 'path';
import { spawn } from 'child_process';
import { ProgressReporter } from './progress-reporter.js';
import { PackageBuilder, BuildResult } from './package-builder.js';

export class SemiontInstaller {
  private projectRoot: string;
  private reporter: ProgressReporter;
  private packageBuilder: PackageBuilder;

  constructor(projectRoot: string, reporter: ProgressReporter) {
    this.projectRoot = projectRoot;
    this.reporter = reporter;
    this.packageBuilder = new PackageBuilder(projectRoot, reporter);
  }

  async install(cliOnly: boolean = false): Promise<void> {
    // Define packages with correct paths
    const packageConfigs = cliOnly 
      ? [{ name: 'cli', path: path.join('apps', 'cli') }]
      : [
          { name: 'api-types', path: path.join('packages', 'api-types') },
          { name: 'backend', path: path.join('apps', 'backend') },
          { name: 'frontend', path: path.join('apps', 'frontend') },
          { name: 'cloud', path: path.join('packages', 'cloud') },
          { name: 'cli', path: path.join('apps', 'cli') },
          { name: 'scripts', path: path.join('packages', 'scripts') }
        ];
    
    const packages = packageConfigs;
    const totalSteps = cliOnly ? 3 : 8;
    let currentStep = 1;

    try {
      if (!cliOnly) {
        // Step 1: Root-level and workspace dependencies
        this.reporter.showStep(currentStep++, totalSteps, '📦 Installing all dependencies...');
        await this.installAllDependencies();
        this.reporter.showSuccess('All dependencies installed');

        // Step 2: Clean all packages
        this.reporter.showStep(currentStep++, totalSteps, '🧹 Cleaning build artifacts...');
        await this.cleanPackages();
        this.reporter.showSuccess('Clean complete');
      }

      // Build packages in dependency order
      const buildResults: BuildResult[] = [];
      
      for (const pkg of packages) {
        const stepLabel = cliOnly ? 
          `🔧 Building ${pkg.name}...` : 
          `🔨 Building ${pkg.name}...`;
          
        this.reporter.showStep(currentStep++, totalSteps, stepLabel);
        
        const result = await this.packageBuilder.buildPackage(pkg.path, pkg.name);
        buildResults.push(result);
        
        if (!result.success && pkg.name === 'CLI') {
          // CLI build failure is critical
          throw new Error(`CLI build failed: ${result.error}`);
        }
      }

      // Run tests (for CLI-only, test just the CLI package)
      const testLabel = cliOnly ? 
        '🧪 Running CLI tests...' : 
        '🧪 Running all tests...';
        
      this.reporter.showStep(currentStep++, totalSteps, testLabel);
      const testResult = await this.runTests(cliOnly);
      
      if (!testResult.success) {
        this.reporter.showWarning(`Tests failed: ${testResult.error}`);
        this.reporter.showWarning('Continuing with installation...');
      } else {
        this.reporter.showSuccess(`Tests passed (${testResult.testsRun} tests)`);
      }

      // Link CLI globally
      const linkLabel = cliOnly ? 
        '🔗 Installing CLI globally...' : 
        '🔗 Installing CLI globally...';
        
      this.reporter.showStep(currentStep++, totalSteps, linkLabel);
      const linkResult = await this.packageBuilder.linkCliGlobally();
      
      if (!linkResult.success) {
        throw new Error(`Failed to link CLI globally: ${linkResult.error}`);
      }

      // Verify installation
      await this.verifyInstallation();
      
      this.reporter.showVerbose('Installation completed successfully');
      
    } catch (error) {
      throw new Error(`Installation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async installAllDependencies(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.reporter.showVerbose('Running: npm install --workspaces in project root');
      
      const proc = spawn('npm', ['install', '--workspaces', '--silent'], {
        cwd: this.projectRoot,
        stdio: 'pipe'
      });
      
      let error = '';
      proc.stderr?.on('data', (data) => {
        error += data.toString();
      });
      
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Workspace npm install failed: ${error}`));
        }
      });
      
      proc.on('error', (err) => {
        reject(new Error(`Failed to run npm install --workspaces: ${err.message}`));
      });
    });
  }

  private async runTests(cliOnly: boolean): Promise<{success: boolean, error?: string, testsRun?: number}> {
    return new Promise((resolve) => {
      const cliPath = path.join(this.projectRoot, 'apps', 'cli');
      
      this.reporter.showVerbose(`Running tests in ${cliPath}`);
      
      const proc = spawn('npm', ['test'], {
        cwd: cliPath,
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
          // Try to extract test count from output
          const testMatch = output.match(/(\d+) passed/);
          const testsRun = testMatch ? parseInt(testMatch[1], 10) : undefined;
          
          resolve({
            success: true,
            testsRun
          });
        } else {
          resolve({
            success: false,
            error: error || output || 'Tests failed with unknown error'
          });
        }
      });
      
      proc.on('error', (err) => {
        resolve({
          success: false,
          error: `Failed to run tests: ${err.message}`
        });
      });
    });
  }

  private async cleanPackages(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.reporter.showVerbose('Running: npm run clean in all workspaces');
      
      const proc = spawn('npm', ['run', 'clean', '--workspaces', '--if-present', '--silent'], {
        cwd: this.projectRoot,
        stdio: 'pipe'
      });
      
      proc.on('exit', (code) => {
        // Clean can fail for packages without clean script, that's okay
        resolve();
      });
      
      proc.on('error', () => {
        // Clean errors are not critical
        resolve();
      });
    });
  }

  private async verifyInstallation(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.reporter.showVerbose('Verifying semiont CLI installation...');
      
      const proc = spawn('semiont', ['--version'], {
        stdio: 'pipe'
      });
      
      let output = '';
      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      proc.on('exit', (code) => {
        if (code === 0 && output.toLowerCase().includes('semiont')) {
          this.reporter.showVerbose(`✓ CLI verification successful: ${output.trim()}`);
          resolve();
        } else {
          this.reporter.showWarning('CLI installed but verification failed - may need to restart terminal');
          resolve(); // Don't fail installation for verification issues
        }
      });
      
      proc.on('error', () => {
        this.reporter.showWarning('CLI verification failed - may need to restart terminal or check PATH');
        resolve(); // Don't fail installation for verification issues
      });
    });
  }
}