#!/usr/bin/env -S npx tsx

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
import path from 'path';

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

async function loadConfigForSuite(environment: Environment, suite?: TestSuite): Promise<any> {
  // SMART CONFIG LOADING: Choose config based on test suite requirements
  // This ensures integration tests always get real databases, even when run locally
  
  // Dynamically import the appropriate config based on test suite requirements
  if (suite === 'integration' || suite === 'e2e') {
    // Integration tests need real database
    const { integrationConfig } = await import('../config/environments/integration');
    const { siteConfig, awsConfig, appConfig } = await import('../config/base');
    
    // Merge base config with integration overrides (simplified merge)
    return {
      site: { ...siteConfig, ...integrationConfig.site },
      aws: { ...awsConfig, ...integrationConfig.aws },
      app: { ...appConfig, ...integrationConfig.app }
    };
  }
  // Cloud environments default to integration-like behavior
  else if (environment === 'development' || environment === 'staging' || environment === 'production') {
    const { integrationConfig } = await import('../config/environments/integration');
    const { siteConfig, awsConfig, appConfig } = await import('../config/base');
    
    return {
      site: { ...siteConfig, ...integrationConfig.site },
      aws: { ...awsConfig, ...integrationConfig.aws },
      app: { ...appConfig, ...integrationConfig.app }
    };
  }
  // Unit and security tests can use mocked dependencies for speed
  else {
    const { unitConfig } = await import('../config/environments/unit');
    const { siteConfig, awsConfig, appConfig } = await import('../config/base');
    
    return {
      site: { ...siteConfig, ...unitConfig.site },
      aws: { ...awsConfig, ...unitConfig.aws },
      app: { ...appConfig, ...unitConfig.app }
    };
  }
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
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

interface DirectoryCoverage {
  name: string;
  statements: { covered: number; total: number; pct: number };
  branches: { covered: number; total: number; pct: number };
  functions: { covered: number; total: number; pct: number };
  lines: { covered: number; total: number; pct: number };
}

async function runCommand(command: string[], cwd: string, description: string, verbose: boolean = false): Promise<{ success: boolean; output: string; duration: number }> {
  return new Promise((resolve) => {
    console.log(`🧪 ${description}...`);
    if (verbose) {
      console.log(`💻 Running: ${command.join(' ')}`);
      console.log(`📁 Working directory: ${path.resolve(cwd)}`);
    }
    
    const startTime = Date.now();
    let output = '';
    
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: verbose ? 'inherit' : ['inherit', 'pipe', 'pipe'],
      shell: false  // Fixed: Don't use shell to avoid security vulnerability
    });

    if (!verbose) {
      // Capture output but only show summary lines
      process.stdout?.on('data', (data: Buffer) => {
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
      process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Only show actual test failures, not intentional error logs
        if (text.includes('FAIL') || text.includes('Error:') && !text.includes('stderr |')) {
          console.error(text);
        }
      });
    }

    process.on('close', (code: number | null) => {
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

    process.on('error', (error: Error) => {
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

async function parseFrontendTestResults(cwd: string): Promise<{ totalTests: number; passedTests: number; failedTests: number }> {
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

function formatEnhancedCoverageTable(data: { total: CoverageSummary; directories: DirectoryCoverage[] }, title: string): void {
  console.log(`\n📊 ${title} Coverage Summary`);
  
  // Overall totals first
  console.log('\n🎯 Overall Coverage');
  console.log('┌────────────┬─────────┐');
  console.log('│ Metric     │ Percent │');
  console.log('├────────────┼─────────┤');
  
  const formatRow = (name: string, pct: number) => {
    const pctStr = `${pct.toFixed(1)}%`;
    const paddedPctStr = pctStr.padStart(7);
    
    // Color coding based on coverage percentage - pad BEFORE adding color codes
    let pctDisplay = '';
    if (pct >= 90) {
      pctDisplay = `\x1b[32m${paddedPctStr}\x1b[0m`; // Green for excellent
    } else if (pct >= 80) {
      pctDisplay = `\x1b[33m${paddedPctStr}\x1b[0m`; // Yellow for good
    } else {
      pctDisplay = `\x1b[31m${paddedPctStr}\x1b[0m`; // Red for needs improvement
    }
    
    console.log(`│ ${name.padEnd(10)} │ ${pctDisplay} │`);
  };
  
  formatRow('Statements', data.total.statements);
  formatRow('Branches', data.total.branches);
  formatRow('Functions', data.total.functions);
  formatRow('Lines', data.total.lines);
  
  console.log('└────────────┴─────────┘');
  
  // Overall assessment
  const avgCoverage = (data.total.statements + data.total.branches + data.total.functions + data.total.lines) / 4;
  let assessment = '';
  if (avgCoverage >= 90) {
    assessment = '🟢 Excellent coverage!';
  } else if (avgCoverage >= 80) {
    assessment = '🟡 Good coverage, room for improvement';
  } else {
    assessment = '🔴 Coverage needs improvement';
  }
  console.log(`${assessment} (Average: ${avgCoverage.toFixed(1)}%)`);

  // Directory breakdown
  if (data.directories.length > 0) {
    console.log('\n📁 Coverage by Directory');
    console.log('┌──────────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Directory    │ Stmts    │ Branch   │ Funcs    │ Lines    │');
    console.log('├──────────────┼──────────┼──────────┼──────────┼──────────┤');
    
    const formatDirRow = (dir: DirectoryCoverage) => {
      const name = dir.name.length > 12 ? dir.name.substring(0, 12) : dir.name;
      const nameCell = name.padEnd(12);
      
      const formatMetric = (pct: number) => {
        const pctStr = `${pct.toFixed(1)}%`;
        const paddedPctStr = pctStr.padStart(8);
        if (pct >= 90) {
          return `\x1b[32m${paddedPctStr}\x1b[0m`;
        } else if (pct >= 80) {
          return `\x1b[33m${paddedPctStr}\x1b[0m`;
        } else {
          return `\x1b[31m${paddedPctStr}\x1b[0m`;
        }
      };
      
      console.log(`│ ${nameCell} │ ${formatMetric(dir.statements.pct)} │ ${formatMetric(dir.branches.pct)} │ ${formatMetric(dir.functions.pct)} │ ${formatMetric(dir.lines.pct)} │`);
    };
    
    data.directories.forEach(formatDirRow);
    console.log('└──────────────┴──────────┴──────────┴──────────┴──────────┘');
  }
}

async function parseCoverageFromSummaryJson(cwd: string): Promise<{ total: CoverageSummary; directories: DirectoryCoverage[] } | null> {
  try {
    const coverageSummaryPath = path.resolve(cwd, 'coverage/coverage-summary.json');
    const summaryData = JSON.parse(await fs.readFile(coverageSummaryPath, 'utf-8'));
    
    if (!summaryData.total) {
      return null;
    }

    // Get total coverage
    const total: CoverageSummary = {
      statements: summaryData.total.statements?.pct || 0,
      branches: summaryData.total.branches?.pct || 0,
      functions: summaryData.total.functions?.pct || 0,
      lines: summaryData.total.lines?.pct || 0
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
  
  const frontendExists = await checkDirectoryExists('../apps/frontend');
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

  const result = await runCommand(testCommand, '../apps/frontend', 'Frontend tests', options.verbose);
  
  // Try to parse JSON results for better summary
  if (!options.verbose && result.success) {
    const testStats = await parseFrontendTestResults('../apps/frontend');
    if (testStats.totalTests > 0) {
      console.log(`✅ ${testStats.passedTests}/${testStats.totalTests} tests passed`);
      if (testStats.failedTests > 0) {
        console.log(`❌ ${testStats.failedTests} tests failed`);
      }
    }
    
    // Show coverage report if coverage was requested
    if (options.coverage) {
      // Parse and display coverage table from JSON
      const coverageData = await parseCoverageFromSummaryJson('../apps/frontend');
      if (coverageData) {
        formatEnhancedCoverageTable(coverageData, 'Frontend');
      }
      
      console.log(`\n📊 Coverage report generated at: apps/frontend/coverage/index.html`);
      console.log(`   Open in browser: file://${process.cwd()}/../apps/frontend/coverage/index.html`);
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
  
  const backendExists = await checkDirectoryExists('../apps/backend');
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

  const result = await runCommand(testCommand, '../apps/backend', 'Backend tests', options.verbose);
  
  // Show coverage report if coverage was requested
  if (options.coverage && result.success && !options.verbose) {
    // Parse and display coverage table from JSON
    const coverageData = await parseCoverageFromSummaryJson('../apps/backend');
    if (coverageData) {
      formatEnhancedCoverageTable(coverageData, 'Backend');
    }
    
    console.log(`\n📊 Coverage report generated at: apps/backend/coverage/index.html`);
    console.log(`   Open in browser: file://${process.cwd()}/../apps/backend/coverage/index.html`);
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
  ./scripts/semiont test [environment] [options]

${colors.cyan}Environments:${colors.reset}
  local          Run tests locally (default, uses mocked dependencies)
  development    Run tests against development environment
  staging        Run tests against staging environment
  production     Run tests against production environment (limited)

${colors.cyan}Options:${colors.reset}
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

  ${colors.dim}# Run integration tests against staging${colors.reset}
  ./scripts/semiont test staging --suite integration

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


async function runTests(options: TestOptions, _config: any): Promise<TestResult[]> {
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
  
  // Parse environment (first argument, optional)
  let environment: Environment = 'local';  // Default to local
  let argIndex = 0;
  
  if (args[0] && !args[0].startsWith('--')) {
    const validEnvironments: Environment[] = ['local', 'development', 'staging', 'production'];
    if (validEnvironments.includes(args[0] as Environment)) {
      environment = args[0] as Environment;
      argIndex = 1;
    }
  }
  
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
  for (let i = argIndex; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
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
        } else if (arg && !arg.startsWith('--')) {
          error(`Unknown argument: ${arg}. Use --suite and --service flags instead.`);
          process.exit(1);
        }
        break;
    }
  }
  
  try {
    // Load configuration for the environment and test suite
    const config = await loadConfigForSuite(environment, options.suite);
    
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
    const results = await runTests(options, config);
    
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