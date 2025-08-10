/**
 * Semiont Installer - Main installation orchestrator
 */

import * as path from 'path';
import { spawn } from 'child_process';
import { ProgressReporter } from './progress-reporter.js';
import { DependencyGraph } from './dependency-graph.js';
import { PackageBuilder, BuildResult } from './package-builder.js';

export class SemiontInstaller {
  private projectRoot: string;
  private reporter: ProgressReporter;
  private dependencyGraph: DependencyGraph;
  private packageBuilder: PackageBuilder;

  constructor(projectRoot: string, reporter: ProgressReporter) {
    this.projectRoot = projectRoot;
    this.reporter = reporter;
    this.dependencyGraph = new DependencyGraph();
    this.packageBuilder = new PackageBuilder(projectRoot, reporter);
  }

  async install(cliOnly: boolean = false): Promise<void> {
    const packages = this.dependencyGraph.getBuildOrder(!cliOnly);
    const totalSteps = cliOnly ? 3 : 6;
    let currentStep = 1;

    try {
      if (!cliOnly) {
        // Step 1: Root-level dependencies
        this.reporter.showStep(currentStep++, totalSteps, '📦 Installing root dependencies...');
        await this.installRootDependencies();
        this.reporter.showSuccess('Root dependencies installed');

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

  private async installRootDependencies(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.reporter.showVerbose('Running: npm install in project root');
      
      const proc = spawn('npm', ['install', '--silent'], {
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
          reject(new Error(`Root npm install failed: ${error}`));
        }
      });
      
      proc.on('error', (err) => {
        reject(new Error(`Failed to run npm install: ${err.message}`));
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
        if (code === 0 && output.includes('semiont')) {
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