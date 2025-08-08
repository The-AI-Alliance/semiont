/**
 * Test Command - Environment-aware testing with consistent service-focused hierarchy
 * 
 * Usage:
 *   ./scripts/semiont test [environment] [options]
 *   ./scripts/semiont test --suite unit --service frontend
 *   ./scripts/semiont test staging --suite e2e
 *   ./scripts/semiont test production --suite integration --service backend
 */

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
// os import removed - no longer needed for temp files
// Import React and ink components that don't have top-level await
import React from 'react';
import { render, Text, Box } from 'ink';
import { SimpleTable } from './lib/ink-utils';

// Project root path resolution (ES module compatible)
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

// Color codes for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message: string, color: string = colors.reset): void {
  console.log(`${color}${message}${colors.reset}`);
}

function error(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function success(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function info(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}


// Types following consistent patterns
type Environment = 'local' | 'development' | 'staging' | 'production';
type TestSuite = 'unit' | 'integration' | 'security' | 'e2e' | 'all';
type TestService = 'database' | 'backend' | 'frontend' | 'all';  // Services to test

interface TestOptions {
  environment: Environment;  // WHERE to run tests  
  suite: TestSuite;         // WHAT kind of tests
  service: TestService;     // WHICH services to test
  coverage?: boolean;
  watch?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

interface TestResult {
  name: string;
  success: boolean;
  duration: number;
  output?: string;
}

interface CoverageSummary {
  statements: { covered: number; total: number; pct: number };
  branches: { covered: number; total: number; pct: number };
  functions: { covered: number; total: number; pct: number };
  lines: { covered: number; total: number; pct: number };
}

interface DirectoryCoverage {
  name: string;
  statements: { covered: number; total: number; pct: number };
  branches: { covered: number; total: number; pct: number };
  functions: { covered: number; total: number; pct: number };
  lines: { covered: number; total: number; pct: number };
}

async function runCommand(command: string[], cwd: string, description: string, verbose: boolean = false, testOptions?: TestOptions): Promise<{ success: boolean; output: string; duration: number }> {
  return new Promise(async (resolve) => {
    console.log(`🧪 ${description}...`);
    if (verbose) {
      console.log(`💻 Running: ${command.join(' ')}`);
      console.log(`📁 Working directory: ${path.resolve(cwd)}`);
    }
    
    const startTime = Date.now();
    let output = '';
    
    // Prepare environment variables for downstream test processes
    const processEnv = { ...process.env };
    
    // Pass environment name instead of temporary config file
    if (testOptions) {
      // Use explicit environment if provided, otherwise use suite-based defaults
      let configEnv: string;
      if (testOptions.environment !== 'local') {
        // User specified a custom environment - use it
        configEnv = testOptions.environment;
      } else if (testOptions.suite === 'integration' || testOptions.suite === 'e2e') {
        // Default to integration config for integration/e2e suites
        configEnv = 'integration';
      } else {
        // Default to unit config for other suites
        configEnv = 'unit';
      }
      
      processEnv.SEMIONT_ENV = configEnv;
      console.log(`📋 Using configuration environment: ${configEnv}`);
    }
    
    const childProcess: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      env: processEnv,
      stdio: verbose ? 'inherit' : ['inherit', 'pipe', 'pipe'],
      shell: false  // Fixed: Don't use shell to avoid security vulnerability
    });

    if (!verbose) {
      // Capture output but only show summary lines
      childProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Only show final summary lines and test suite completion
        const lines = text.split('\n');
        lines.forEach((line: string) => {
          if (line.includes('Test Files') || line.includes('Tests:') || 
              line.includes('Snapshots:') || line.includes('Time:') || 
              line.includes('Duration') || line.includes('✓') || 
              line.includes('✗') || line.includes('PASS') || 
              line.includes('FAIL') || line.trim().match(/^\s*✓\s+\w+/)) {
            console.log(line);
          }
        });
      });

      // Suppress stderr noise from intentional test errors
      childProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Only show actual test failures, not intentional error logs
        if (text.includes('FAIL') || text.includes('Error:') && !text.includes('stderr |')) {
          console.error(text);
        }
      });
    }

    childProcess.on('close', async (code: number | null) => {
      const duration = Date.now() - startTime;
      
      if (code === 0) {
        console.log(`✅ ${description} completed`);
      } else {
        console.log(`❌ ${description} failed (exit code ${code})`);
        // Show output on failure if not in verbose mode
        if (!verbose && output) {
          console.log('\n--- Test Output ---');
          console.log(output);
          console.log('--- End Test Output ---\n');
        }
      }
      resolve({ success: code === 0, output, duration });
    });

    childProcess.on('error', async (error: Error) => {
      const duration = Date.now() - startTime;
      
      console.error(`❌ ${description} failed: ${error.message}`);
      resolve({ success: false, output: error.message, duration });
    });
  });
}

async function checkDirectoryExists(dirPath: string): Promise<boolean> {
  try {
    const resolvedPath = path.resolve(dirPath);
    await fs.access(resolvedPath);
    return true;
  } catch {
    return false;
  }
}

async function parseTestResults(cwd: string): Promise<{ totalTests: number; passedTests: number; failedTests: number }> {
  try {
    const testResultsPath = path.resolve(cwd, 'test-results.json');
    const testResults = await fs.readFile(testResultsPath, 'utf-8');
    const results = JSON.parse(testResults);
    
    return {
      totalTests: results.numTotalTests || 0,
      passedTests: results.numPassedTests || 0,
      failedTests: results.numFailedTests || 0
    };
  } catch (error) {
    console.log('⚠️  Could not parse test results JSON, using basic parsing');
    return { totalTests: 0, passedTests: 0, failedTests: 0 };
  }
}

function displayTestSummary(testStats: { totalTests: number; passedTests: number; failedTests: number }): void {
  if (testStats.totalTests > 0) {
    const skippedTests = testStats.totalTests - testStats.passedTests - testStats.failedTests;
    
    if (testStats.failedTests > 0) {
      console.log(`❌ ${testStats.failedTests} tests failed, ${testStats.passedTests} passed`);
    } else if (skippedTests > 0) {
      console.log(`✅ All ${testStats.passedTests} tests passed • ${skippedTests} skipped • ${testStats.totalTests} total`);
    } else {
      console.log(`✅ All ${testStats.passedTests} tests passed`);
    }
  }
}


// SimpleTable component is now imported from lib/ink-utils.ts

async function formatInkCoverageTable(data: { total: CoverageSummary; directories: DirectoryCoverage[] }, title: string): Promise<void> {
  return new Promise((resolve) => {
    // Helper function to format metric with percentage and counts
    const formatMetric = (metric: { covered: number; total: number; pct: number }): string => {
      return `${metric.pct.toFixed(1)}% of ${metric.total}`;
    };

    // Overall coverage table data
    const overallTableData = [
      {
        Metric: 'Statements',
        Coverage: formatMetric(data.total.statements)
      },
      {
        Metric: 'Branches',
        Coverage: formatMetric(data.total.branches)
      },
      {
        Metric: 'Functions',
        Coverage: formatMetric(data.total.functions)
      },
      {
        Metric: 'Lines',
        Coverage: formatMetric(data.total.lines)
      }
    ];

    // Directory coverage table data
    const directoryTableData = data.directories.map(dir => ({
      Directory: dir.name,
      Statements: formatMetric(dir.statements),
      Branches: formatMetric(dir.branches),
      Functions: formatMetric(dir.functions),
      Lines: formatMetric(dir.lines)
    }));

    // Calculate average coverage for assessment
    const avgCoverage = (
      data.total.statements.pct + 
      data.total.branches.pct + 
      data.total.functions.pct + 
      data.total.lines.pct
    ) / 4;

    let assessment = '';
    let assessmentColor: 'green' | 'yellow' | 'red' = 'red';
    
    if (avgCoverage >= 90) {
      assessment = '🟢 Excellent coverage!';
      assessmentColor = 'green';
    } else if (avgCoverage >= 80) {
      assessment = '🟡 Good coverage, room for improvement';
      assessmentColor = 'yellow';
    } else {
      assessment = '🔴 Coverage needs improvement';
      assessmentColor = 'red';
    }

    // Create React elements using createElement to avoid JSX in .ts file
    const coverageElements: any[] = [
      React.createElement(Text, { bold: true, color: 'magenta', key: 'title' }, `📊 ${title} Coverage Summary`),
      React.createElement(Text, { bold: true, color: 'cyan', key: 'overall-title' }, '\n🎯 Overall Coverage'),
      React.createElement(SimpleTable, { 
        data: overallTableData, 
        columns: ['Metric', 'Coverage'],
        key: 'overall-table' 
      }),
      React.createElement(Text, { color: assessmentColor, key: 'assessment' }, 
        `\n${assessment} (Average: ${avgCoverage.toFixed(1)}%)`),
    ];

    // Add directory table if there are directories
    if (directoryTableData.length > 0) {
      coverageElements.push(
        React.createElement(Text, { bold: true, color: 'cyan', key: 'directory-title' }, '\n📁 Coverage by Directory'),
        React.createElement(SimpleTable, { 
          data: directoryTableData, 
          columns: ['Directory', 'Statements', 'Branches', 'Functions', 'Lines'],
          key: 'directory-table' 
        })
      );
    }

    // Add spacing at the end
    coverageElements.push(React.createElement(Text, { key: 'spacing' }, '\n'));

    const CoverageReport = React.createElement(Box, { flexDirection: 'column' }, coverageElements);

    // Render the component and auto-unmount after a short delay
    const { unmount } = render(CoverageReport);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

async function parseCoverageFromSummaryJson(cwd: string): Promise<{ total: CoverageSummary; directories: DirectoryCoverage[] } | null> {
  try {
    const coverageSummaryPath = path.resolve(cwd, 'coverage/coverage-summary.json');
    const summaryData = JSON.parse(await fs.readFile(coverageSummaryPath, 'utf-8'));
    
    if (!summaryData.total) {
      return null;
    }

    // Get total coverage with raw counts
    const total: CoverageSummary = {
      statements: {
        covered: summaryData.total.statements?.covered || 0,
        total: summaryData.total.statements?.total || 0,
        pct: summaryData.total.statements?.pct || 0
      },
      branches: {
        covered: summaryData.total.branches?.covered || 0,
        total: summaryData.total.branches?.total || 0,
        pct: summaryData.total.branches?.pct || 0
      },
      functions: {
        covered: summaryData.total.functions?.covered || 0,
        total: summaryData.total.functions?.total || 0,
        pct: summaryData.total.functions?.pct || 0
      },
      lines: {
        covered: summaryData.total.lines?.covered || 0,
        total: summaryData.total.lines?.total || 0,
        pct: summaryData.total.lines?.pct || 0
      }
    };

    // Aggregate coverage by directory
    const directoriesMap = new Map<string, {
      statements: { covered: number; total: number };
      branches: { covered: number; total: number };
      functions: { covered: number; total: number };
      lines: { covered: number; total: number };
    }>();

    // Process each file entry (skip "total" key)
    for (const [filePath, fileData] of Object.entries(summaryData)) {
      if (filePath === 'total') continue;
      
      // Extract top-level directory from file path
      // Example: "/path/to/project/src/components/Header.tsx" -> "components"
      // Example: "/path/to/project/src/app/page.tsx" -> "app"
      const relativePath = filePath.replace(/.*\/src\//, ''); // Remove everything up to /src/
      const topLevelDir = relativePath.split('/')[0] || 'root';
      
      if (!directoriesMap.has(topLevelDir)) {
        directoriesMap.set(topLevelDir, {
          statements: { covered: 0, total: 0 },
          branches: { covered: 0, total: 0 },
          functions: { covered: 0, total: 0 },
          lines: { covered: 0, total: 0 }
        });
      }
      
      const dirData = directoriesMap.get(topLevelDir)!;
      const file = fileData as any;
      
      // Aggregate metrics
      dirData.statements.covered += file.statements?.covered || 0;
      dirData.statements.total += file.statements?.total || 0;
      dirData.branches.covered += file.branches?.covered || 0;
      dirData.branches.total += file.branches?.total || 0;
      dirData.functions.covered += file.functions?.covered || 0;
      dirData.functions.total += file.functions?.total || 0;
      dirData.lines.covered += file.lines?.covered || 0;
      dirData.lines.total += file.lines?.total || 0;
    }

    // Convert to DirectoryCoverage array with calculated percentages
    const directories: DirectoryCoverage[] = Array.from(directoriesMap.entries()).map(([name, data]) => ({
      name,
      statements: {
        covered: data.statements.covered,
        total: data.statements.total,
        pct: data.statements.total > 0 ? (data.statements.covered / data.statements.total) * 100 : 0
      },
      branches: {
        covered: data.branches.covered,
        total: data.branches.total,
        pct: data.branches.total > 0 ? (data.branches.covered / data.branches.total) * 100 : 0
      },
      functions: {
        covered: data.functions.covered,
        total: data.functions.total,
        pct: data.functions.total > 0 ? (data.functions.covered / data.functions.total) * 100 : 0
      },
      lines: {
        covered: data.lines.covered,
        total: data.lines.total,
        pct: data.lines.total > 0 ? (data.lines.covered / data.lines.total) * 100 : 0
      }
    })).sort((a, b) => a.name.localeCompare(b.name)); // Sort alphabetically

    return { total, directories };
  } catch (error) {
    return null;
  }
}

async function runFrontendTestsImpl(options: TestOptions): Promise<TestResult> {
  console.log('🎨 Running frontend tests...');
  
  const frontendExists = await checkDirectoryExists(path.join(PROJECT_ROOT, 'apps/frontend'));
  if (!frontendExists) {
    console.log('⚠️  Frontend directory not found, skipping frontend tests');
    return { name: 'Frontend', success: false, duration: 0 };
  }

  // Environment already set by loadEnvironmentConfig() based on test suite

  // Determine test command based on options
  let testCommand = ['npm', 'run'];
  
  if (options.suite === 'security') {
    testCommand.push('test:security');
  } else if (options.suite === 'unit') {
    testCommand.push('test:unit');
  } else if (options.suite === 'integration') {
    testCommand.push('test:integration');
  } else if (options.coverage) {
    testCommand.push('test:coverage');
  } else if (options.watch) {
    testCommand.push('test:watch');
  } else {
    testCommand.push('test');
  }

  const result = await runCommand(testCommand, path.join(PROJECT_ROOT, 'apps/frontend'), 'Frontend tests', options.verbose, options);
  
  // Try to parse JSON results for better summary
  if (!options.verbose && result.success) {
    const testStats = await parseTestResults(path.join(PROJECT_ROOT, 'apps/frontend'));
    displayTestSummary(testStats);
    
    // Show coverage report if coverage was requested
    if (options.coverage) {
      // Parse and display coverage table from JSON
      const coverageData = await parseCoverageFromSummaryJson(path.join(PROJECT_ROOT, 'apps/frontend'));
      if (coverageData) {
        // Use ink-table for rich coverage display
        await formatInkCoverageTable(coverageData, 'Frontend');
      }
      
      console.log(`\n📊 Coverage report generated at: apps/frontend/coverage/index.html`);
      console.log(`   Open in browser: file://${PROJECT_ROOT}/apps/frontend/coverage/index.html`);
    }
  }
  
  return {
    name: 'Frontend',
    success: result.success,
    duration: result.duration,
    output: result.output
  };
}

async function runBackendTestsImpl(options: TestOptions): Promise<TestResult> {
  console.log('🚀 Running backend tests...');
  
  const backendExists = await checkDirectoryExists(path.join(PROJECT_ROOT, 'apps/backend'));
  if (!backendExists) {
    console.log('⚠️  Backend directory not found, skipping backend tests');
    return { name: 'Backend', success: false, duration: 0 };
  }

  // Environment already set by loadEnvironmentConfig() based on test suite

  // Determine test command based on options
  let testCommand = ['npm', 'run'];
  
  if (options.suite === 'security') {
    testCommand.push('test:security');
  } else if (options.suite === 'unit') {
    testCommand.push('test:unit');
  } else if (options.suite === 'integration') {
    testCommand.push('test:integration');
  } else if (options.coverage) {
    testCommand.push('test:coverage');
  } else if (options.watch) {
    testCommand.push('test:watch');
  } else {
    testCommand.push('test');
  }

  const result = await runCommand(testCommand, path.join(PROJECT_ROOT, 'apps/backend'), 'Backend tests', options.verbose, options);
  
  // Try to parse JSON results for better summary (same as frontend)
  if (!options.verbose && result.success) {
    const testStats = await parseTestResults(path.join(PROJECT_ROOT, 'apps/backend'));
    displayTestSummary(testStats);
    
    // Show coverage report if coverage was requested
    if (options.coverage) {
      // Parse and display coverage table from JSON
      const coverageData = await parseCoverageFromSummaryJson(path.join(PROJECT_ROOT, 'apps/backend'));
      if (coverageData) {
        // Use ink-table for rich coverage display
        await formatInkCoverageTable(coverageData, 'Backend');
      }
      
      console.log(`\n📊 Coverage report generated at: apps/backend/coverage/index.html`);
      console.log(`   Open in browser: file://${PROJECT_ROOT}/apps/backend/coverage/index.html`);
    }
  }
  
  return {
    name: 'Backend',
    success: result.success,
    duration: result.duration,
    output: result.output
  };
}



function printHelp(): void {
  console.log(`
${colors.bright}🧪 Semiont Test Command${colors.reset}

${colors.cyan}Usage:${colors.reset}
  ./scripts/semiont test [options]

${colors.cyan}Options:${colors.reset}
  --environment <env>  Environment config to use: local, development, staging, production, or custom (default: local)
  --suite <type>       Test suite: unit, integration, security, e2e, all (default: all)
  --service <services> Service to test: database, backend, frontend, all (default: all)
  --coverage           Enable coverage reporting (default: enabled)
  --no-coverage        Disable coverage reporting
  --watch              Watch mode for continuous testing
  --verbose            Show detailed output
  --dry-run            Show what would be tested without running
  --help               Show this help message

${colors.cyan}Examples:${colors.reset}
  ${colors.dim}# Run all tests locally${colors.reset}
  ./scripts/semiont test

  ${colors.dim}# Run unit tests for frontend only${colors.reset}
  ./scripts/semiont test --suite unit --service frontend

  ${colors.dim}# Run integration tests against custom 'foo' environment${colors.reset}
  ./scripts/semiont test --environment foo --suite integration

  ${colors.dim}# Run integration tests against staging${colors.reset}
  ./scripts/semiont test --environment staging --suite integration

  ${colors.dim}# Run security tests in watch mode${colors.reset}
  ./scripts/semiont test --suite security --service frontend --watch

  ${colors.dim}# Run all tests without coverage${colors.reset}
  ./scripts/semiont test --no-coverage

${colors.cyan}Test Suites:${colors.reset}
  unit           Fast, isolated tests with mocked dependencies
  integration    Tests with real database and services
  security       Security-focused validation tests
  e2e            End-to-end tests (staging/production only)
  all            All applicable test suites (default)

${colors.cyan}Test Services:${colors.reset}
  database       Database-related tests (migrations, queries)
  backend        Backend/API service tests  
  frontend       Frontend/UI service tests
  all            All services (default)

${colors.cyan}Notes:${colors.reset}
  • Local tests use mocked dependencies for speed
  • Cloud environment tests use real services
  • E2E tests only run against staging/production
  • Coverage is enabled by default for better insights
`);
}


async function runTests(options: TestOptions): Promise<TestResult[]> {
  const { environment, suite, service, coverage, watch, verbose, dryRun } = options;
  
  log(`🧪 Running ${suite} tests for ${service} services in ${environment} environment`, colors.bright);
  
  const results: TestResult[] = [];
  
  if (dryRun) {
    info('DRY RUN - Showing what would be tested:');
    
    if (service === 'frontend' || service === 'all') {
      console.log(`  • Frontend ${suite} tests`);
    }
    if (service === 'backend' || service === 'all') {
      console.log(`  • Backend ${suite} tests`);
    }
    if (service === 'database' || service === 'all') {
      console.log(`  • Database ${suite} tests`);
    }
    
    // Return mock results for dry run
    return [{
      name: 'Dry Run',
      success: true,
      duration: 0,
      output: 'This was a dry run - no tests were actually executed'
    }];
  }
  
  try {
    // Run frontend tests
    if (service === 'frontend' || service === 'all') {
      const frontendResult = await runFrontendTests(suite, { 
        coverage: coverage ?? true, 
        watch: watch ?? false, 
        verbose: verbose ?? false 
      });
      results.push({
        name: 'Frontend',
        success: frontendResult.success,
        duration: frontendResult.duration,
        output: frontendResult.output ?? ''
      });
    }
    
    // Run backend tests
    if (service === 'backend' || service === 'all') {
      const backendResult = await runBackendTests(suite, { 
        coverage: coverage ?? true, 
        watch: watch ?? false, 
        verbose: verbose ?? false 
      });
      results.push({
        name: 'Backend',
        success: backendResult.success,
        duration: backendResult.duration,
        output: backendResult.output ?? ''
      });
    }
    
    // Run database tests (if applicable)
    if (service === 'database' || service === 'all') {
      if (suite === 'integration' || suite === 'all') {
        info('Database tests are included in backend integration tests');
      } else {
        info('Database tests only run as part of integration test suite');
      }
    }
    
    return results;
  } catch (err) {
    error(`Test execution failed: ${err instanceof Error ? err.message : String(err)}`);
    return [{
      name: 'Test Execution',
      success: false,
      duration: 0,
      output: err instanceof Error ? err.message : String(err)
    }];
  }
}

async function runFrontendTests(suite: TestSuite, options: { coverage?: boolean; watch?: boolean; verbose?: boolean }) {
  // Delegate to existing frontend test logic
  return await runFrontendTestsImpl({
    environment: 'local',
    suite: suite,
    service: 'frontend',
    coverage: options.coverage ?? true,
    watch: options.watch ?? false,
    verbose: options.verbose ?? false
  });
}

async function runBackendTests(suite: TestSuite, options: { coverage?: boolean; watch?: boolean; verbose?: boolean }) {
  // Delegate to existing backend test logic  
  return await runBackendTestsImpl({
    environment: 'local',
    suite: suite,
    service: 'backend', 
    coverage: options.coverage ?? true,
    watch: options.watch ?? false,
    verbose: options.verbose ?? false
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // Check for help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  
  // Default environment
  let environment: Environment = 'local';
  
  // Parse options
  const options: TestOptions = {
    environment,
    suite: 'all',
    service: 'all',
    coverage: !args.includes('--no-coverage'),
    watch: args.includes('--watch'),
    verbose: args.includes('--verbose'),
    dryRun: args.includes('--dry-run')
  };
  
  // Process command line arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--environment':
        const envArg = args[++i];
        if (!envArg) {
          throw new Error('--environment requires a value');
        }
        // Allow any environment name (not just predefined ones)
        environment = envArg as Environment;
        options.environment = environment;
        break;
      case '--suite':
        const suite = args[++i];
        if (!suite) {
          throw new Error('--suite requires a value');
        }
        if (!['unit', 'integration', 'security', 'e2e', 'all'].includes(suite)) {
          throw new Error(`Invalid suite: ${suite}. Must be one of: unit, integration, security, e2e, all`);
        }
        options.suite = suite as TestSuite;
        break;
      case '--service':
        const service = args[++i];
        if (!service) {
          throw new Error('--service requires a value');
        }
        if (!['database', 'backend', 'frontend', 'all'].includes(service)) {
          throw new Error(`Invalid service: ${service}. Must be one of: database, backend, frontend, all`);
        }
        options.service = service as TestService;
        break;
      case '--coverage':
        options.coverage = true;
        break;
      case '--no-coverage':
        options.coverage = false;
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        if (arg && arg.startsWith('--')) {
          error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        break;
    }
  }
  
  try {
    
    // Show test plan
    console.log('');
    info('Test Plan:');
    console.log(`  Environment: ${colors.bright}${environment}${colors.reset}`);
    console.log(`  Suite:       ${colors.bright}${options.suite}${colors.reset}`);
    console.log(`  Service:     ${colors.bright}${options.service}${colors.reset}`);
    console.log(`  Coverage:    ${colors.bright}${options.coverage ? 'enabled' : 'disabled'}${colors.reset}`);
    
    if (options.dryRun) {
      console.log(`  Mode:        ${colors.yellow}DRY RUN${colors.reset}`);
    }
    if (options.watch) {
      console.log(`  Mode:        ${colors.cyan}WATCH${colors.reset}`);
    }
    
    console.log('');
    
    // Execute tests
    const results = await runTests(options);
    
    // Show results  
    const allPassed = results.every((result: TestResult) => result.success);
    
    if (allPassed) {
      success(`All tests passed in ${environment} environment!`);
    } else {
      error(`Some tests failed in ${environment} environment`);
      process.exit(1);
    }
    
  } catch (err) {
    error(`Test execution failed: ${err instanceof Error ? err.message : String(err)}`);
    if (options.verbose) {
      console.error(err);
    }
    process.exit(1);
  }
}

main().catch(console.error);