
/**
 * Benchmark Command - Performance benchmarking and analysis for Semiont
 * Provides bundle analysis, lighthouse testing, and performance monitoring
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Use project root for path resolution
const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd().split('/packages')[0] || process.cwd();
const FRONTEND_DIR = join(PROJECT_ROOT, 'apps/frontend');

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [command]')
  .command('analyze', 'Run bundle analysis with visual report')
  .command('monitor', 'Run performance monitoring')
  .command('lighthouse', 'Run Lighthouse CI tests')
  .command('check', 'Run comprehensive performance check')
  .command('report', 'Show latest performance report')
  .help()
  .alias('h', 'help')
  .parse();

class PerformanceManager {
  private frontendDir: string;

  constructor() {
    this.frontendDir = FRONTEND_DIR;
    this.validateEnvironment();
  }

  private validateEnvironment() {
    if (!existsSync(this.frontendDir)) {
      console.error(chalk.red('❌ Frontend directory not found'));
      process.exit(1);
    }

    const packagePath = join(this.frontendDir, 'package.json');
    if (!existsSync(packagePath)) {
      console.error(chalk.red('❌ Frontend package.json not found'));
      process.exit(1);
    }
  }

  private runCommand(command: string, options: { cwd?: string } = {}) {
    try {
      execSync(command, {
        stdio: 'inherit',
        cwd: options.cwd || this.frontendDir,
      });
    } catch (error) {
      console.error(chalk.red(`❌ Command failed: ${command}`));
      process.exit(1);
    }
  }

  async analyze() {
    console.log(chalk.blue('📊 Running bundle analysis...\n'));
    
    // Check if dependencies are installed
    console.log(chalk.gray('Checking dependencies...'));
    this.runCommand('npm list @next/bundle-analyzer --depth=0 || npm install');
    
    console.log(chalk.yellow('\n🔍 Building with bundle analyzer...'));
    this.runCommand('npm run analyze');
    
    console.log(chalk.green('\n✅ Bundle analysis complete!'));
    console.log(chalk.gray('Check the opened browser window for the visual report'));
  }

  async monitor() {
    console.log(chalk.blue('🚀 Running performance monitoring...\n'));
    
    // Ensure build is up to date
    console.log(chalk.gray('Building application...'));
    this.runCommand('npm run build');
    
    console.log(chalk.yellow('\n📈 Running performance monitor...'));
    this.runCommand('npm run perf-monitor');
    
    // Show report location
    const reportDir = join(this.frontendDir, 'performance-reports');
    console.log(chalk.green('\n✅ Performance monitoring complete!'));
    console.log(chalk.gray(`Reports saved to: ${reportDir}`));
  }

  async lighthouse() {
    console.log(chalk.blue('💡 Running Lighthouse CI tests...\n'));
    
    // Check if server is running
    console.log(chalk.yellow('⚠️  Note: Lighthouse requires the application to be running'));
    console.log(chalk.gray('Starting the application in the background...\n'));
    
    // Start the server in background
    const serverProcess = require('child_process').spawn('npm', ['start'], {
      cwd: this.frontendDir,
      detached: false,
      stdio: 'ignore'
    });
    
    // Wait for server to start
    console.log(chalk.gray('Waiting for server to start...'));
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    try {
      console.log(chalk.yellow('\n🔍 Running Lighthouse tests...'));
      this.runCommand('npm run lighthouse');
      
      console.log(chalk.green('\n✅ Lighthouse tests complete!'));
    } finally {
      // Kill the server process
      serverProcess.kill();
    }
  }

  async check() {
    console.log(chalk.blue('🔍 Running comprehensive performance check...\n'));
    
    // Run all checks
    console.log(chalk.yellow('1/3 Building application...'));
    this.runCommand('npm run build');
    
    console.log(chalk.yellow('\n2/3 Running performance monitor...'));
    this.runCommand('npm run perf-monitor');
    
    console.log(chalk.yellow('\n3/3 Running bundle analysis...'));
    this.runCommand('npm run analyze');
    
    console.log(chalk.green('\n✅ Comprehensive performance check complete!'));
  }

  async report() {
    console.log(chalk.blue('📊 Latest Performance Report\n'));
    
    const reportDir = join(this.frontendDir, 'performance-reports');
    if (!existsSync(reportDir)) {
      console.log(chalk.yellow('No performance reports found. Run monitoring first:'));
      console.log(chalk.gray('  semiont benchmark monitor'));
      return;
    }
    
    // Find latest report
    const { readdirSync, readFileSync } = require('fs');
    const reports = readdirSync(reportDir)
      .filter((f: string) => f.endsWith('.json'))
      .sort()
      .reverse();
    
    if (reports.length === 0) {
      console.log(chalk.yellow('No reports found'));
      return;
    }
    
    const latestReport = join(reportDir, reports[0]);
    const report = JSON.parse(readFileSync(latestReport, 'utf8'));
    
    // Display summary
    console.log(chalk.gray(`Report: ${reports[0]}`));
    console.log(chalk.gray(`Generated: ${report.timestamp}\n`));
    
    if (report.results.bundleAnalysis && !report.results.bundleAnalysis.error) {
      const { totalSize, jsSize, cssSize } = report.results.bundleAnalysis;
      console.log(chalk.white('📦 Bundle Size:'));
      console.log(`   Total: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   JavaScript: ${(jsSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   CSS: ${(cssSize / 1024).toFixed(2)} KB`);
    }
    
    if (report.results.warnings.length > 0) {
      console.log(chalk.yellow(`\n⚠️  Warnings (${report.results.warnings.length}):`));
      report.results.warnings.forEach((w: string) => console.log(`   • ${w}`));
    }
    
    if (report.results.recommendations.length > 0) {
      console.log(chalk.cyan(`\n💡 Recommendations:`));
      report.results.recommendations.forEach((rec: any) => {
        const icon = rec.priority === 'high' ? '🔴' : 
                    rec.priority === 'medium' ? '🟡' : '🟢';
        console.log(`   ${icon} ${rec.title}`);
        if (rec.actions && rec.actions.length > 0) {
          console.log(chalk.gray(`      ${rec.actions[0]}`));
        }
      });
    }
  }

  async run() {
    const parsedArgv = await argv;
    const command = parsedArgv._[0] || 'check';
    
    switch (command) {
      case 'analyze':
        await this.analyze();
        break;
      case 'monitor':
        await this.monitor();
        break;
      case 'lighthouse':
        await this.lighthouse();
        break;
      case 'check':
        await this.check();
        break;
      case 'report':
        await this.report();
        break;
      default:
        console.log(chalk.red(`Unknown command: ${command}`));
        console.log(chalk.gray('Run with --help for usage'));
        process.exit(1);
    }
  }
}

// Run the performance manager
const manager = new PerformanceManager();
manager.run().catch(error => {
  console.error(chalk.red('Error:'), error);
  process.exit(1);
});