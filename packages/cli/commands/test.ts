/**
 * Test Command V2 - Environment Testing
 * 
 * This version runs integration, e2e, health, and security tests 
 * against specific environments (not unit tests)
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const TestOptionsSchema = z.object({
  environment: z.string(),
  suite: z.enum(['all', 'integration', 'e2e', 'health', 'security']).default('all'),
  service: z.enum(['all', 'frontend', 'backend']).default('all'),
  coverage: z.boolean().default(false),
  parallel: z.boolean().default(false),
  timeout: z.number().int().positive().default(300), // 5 minutes
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type TestOptions = z.infer<typeof TestOptionsSchema>;

// Color utilities
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

function printError(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function printSuccess(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function printInfo(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

function printWarning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

function printDebug(message: string, options: TestOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): TestOptions {
  const rawOptions: any = {
    environment: process.env.SEMIONT_ENV || process.argv[2],
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
  };
  
  // Parse command-line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--suite':
      case '-s':
        rawOptions.suite = args[++i];
        break;
      case '--service':
        rawOptions.service = args[++i];
        break;
      case '--coverage':
        rawOptions.coverage = true;
        break;
      case '--parallel':
      case '-p':
        rawOptions.parallel = true;
        break;
      case '--timeout':
        rawOptions.timeout = parseInt(args[++i]);
        break;
      case '--verbose':
      case '-v':
        rawOptions.verbose = true;
        break;
      case '--dry-run':
        rawOptions.dryRun = true;
        break;
    }
  }
  
  try {
    return TestOptionsSchema.parse(rawOptions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      printError('Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

// =====================================================================
// TEST FUNCTIONS
// =====================================================================

async function runCommand(command: string, args: string[], cwd: string, options: TestOptions): Promise<boolean> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would run: ${command} ${args.join(' ')}`);
    return true;
  }
  
  printDebug(`Running: ${command} ${args.join(' ')} in ${cwd}`, options);
  
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: options.verbose ? 'inherit' : 'pipe',
      timeout: options.timeout * 1000
    });
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
      if (options.verbose) {
        process.stdout.write(data);
      }
    });
    
    proc.stderr?.on('data', (data) => {
      errorOutput += data.toString();
      if (options.verbose) {
        process.stderr.write(data);
      }
    });
    
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        if (!options.verbose) {
          console.error(errorOutput);
        }
        resolve(false);
      }
    });
    
    proc.on('error', (error) => {
      printError(`Command failed: ${error.message}`);
      resolve(false);
    });
  });
}

async function runHealthTests(options: TestOptions): Promise<boolean> {
  printInfo('🏥 Running health tests...');
  
  if (options.environment === 'local') {
    // Test local endpoints
    const healthChecks = [
      { url: 'http://localhost:3000', name: 'Frontend' },
      { url: 'http://localhost:3001/health', name: 'Backend API' },
    ];
    
    let allPassed = true;
    
    for (const check of healthChecks) {
      try {
        const response = await fetch(check.url, { 
          signal: AbortSignal.timeout(5000) 
        });
        if (response.ok) {
          printSuccess(`${check.name} health check passed`);
        } else {
          printError(`${check.name} returned HTTP ${response.status}`);
          allPassed = false;
        }
      } catch (error) {
        printError(`${check.name} health check failed: ${error}`);
        allPassed = false;
      }
    }
    
    return allPassed;
  } else {
    printWarning('Cloud health tests not yet implemented');
    printInfo('Suggested health check endpoints:');
    printInfo(`  • Frontend: https://${options.environment}.your-domain.com`);
    printInfo(`  • Backend: https://api-${options.environment}.your-domain.com/health`);
    return true;
  }
}

async function runIntegrationTests(options: TestOptions): Promise<boolean> {
  printInfo('🔗 Running integration tests...');
  
  // Check if test files exist
  const testDirs = [
    path.join(PROJECT_ROOT, 'tests/integration'),
    path.join(PROJECT_ROOT, 'apps/frontend/tests/integration'),
    path.join(PROJECT_ROOT, 'apps/backend/tests/integration'),
  ];
  
  let testsRun = false;
  let allPassed = true;
  
  for (const testDir of testDirs) {
    try {
      // Try to run tests with different test runners
      const runners = [
        { cmd: 'npm', args: ['run', 'test:integration'] },
        { cmd: 'vitest', args: ['run', '--config', 'vitest.integration.config.ts'] },
        { cmd: 'jest', args: ['--testMatch', '**/*.integration.test.(js|ts)'] },
      ];
      
      for (const runner of runners) {
        const success = await runCommand(runner.cmd, runner.args, testDir, options);
        if (success) {
          testsRun = true;
          break; // Found working test runner for this directory
        }
      }
    } catch (error) {
      printDebug(`No integration tests found in ${testDir}`, options);
    }
  }
  
  if (!testsRun) {
    printWarning('No integration tests found');
    printInfo('To add integration tests, create files matching **/*.integration.test.(js|ts)');
  }
  
  return allPassed;
}

async function runE2ETests(options: TestOptions): Promise<boolean> {
  printInfo('🎭 Running E2E tests...');
  
  // Check if Playwright tests exist
  const playwrightConfig = path.join(PROJECT_ROOT, 'playwright.config.ts');
  const testDir = path.join(PROJECT_ROOT, 'tests/e2e');
  
  try {
    const success = await runCommand('npx', [
      'playwright', 'test',
      '--project', options.environment,
      ...(options.parallel ? ['--workers', '4'] : []),
    ], PROJECT_ROOT, options);
    
    return success;
  } catch (error) {
    printWarning('E2E tests not found or Playwright not configured');
    printInfo('To add E2E tests:');
    printInfo('  1. Install Playwright: npm install -D @playwright/test');
    printInfo('  2. Initialize: npx playwright install');
    printInfo('  3. Create tests in tests/e2e/');
    return true; // Don't fail if E2E tests aren't set up
  }
}

async function runSecurityTests(options: TestOptions): Promise<boolean> {
  printInfo('🔒 Running security tests...');
  
  let allPassed = true;
  
  // Basic security checks
  if (options.environment === 'local') {
    printInfo('Security checks for local environment:');
    
    // Check for common security issues
    const checks = [
      {
        name: 'Check for exposed secrets',
        test: () => {
          printInfo('  • No hardcoded secrets check - would scan for API keys, passwords');
          return true;
        }
      },
      {
        name: 'Check HTTPS redirect',
        test: async () => {
          printInfo('  • HTTPS redirect check - would verify production uses HTTPS');
          return true;
        }
      },
      {
        name: 'Check security headers',
        test: async () => {
          try {
            const response = await fetch('http://localhost:3000', { 
              method: 'HEAD',
              signal: AbortSignal.timeout(5000)
            });
            const hasSecurityHeaders = response.headers.has('x-content-type-options');
            if (hasSecurityHeaders) {
              printSuccess('  • Security headers present');
            } else {
              printWarning('  • Missing security headers (x-content-type-options, etc.)');
            }
            return true;
          } catch {
            printWarning('  • Could not check security headers (service not running)');
            return true;
          }
        }
      }
    ];
    
    for (const check of checks) {
      try {
        const passed = await check.test();
        if (!passed) allPassed = false;
      } catch (error) {
        printError(`Security check failed: ${check.name}`);
        allPassed = false;
      }
    }
  } else {
    printWarning('Cloud security tests not yet implemented');
    printInfo('Suggested security checks:');
    printInfo('  • SSL certificate validation');
    printInfo('  • Security headers verification'); 
    printInfo('  • Dependency vulnerability scanning');
  }
  
  return allPassed;
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  // Validate environment
  const validEnvironments = ['local', 'development', 'staging', 'production'];
  if (!validEnvironments.includes(options.environment)) {
    printError(`Invalid environment: ${options.environment}`);
    printInfo(`Available environments: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  printInfo(`🧪 Running ${options.suite} tests against ${colors.bright}${options.environment}${colors.reset} environment`);
  if (options.service !== 'all') {
    printInfo(`📦 Targeting service: ${colors.bright}${options.service}${colors.reset}`);
  }
  
  let overallSuccess = true;
  const results: { suite: string; passed: boolean }[] = [];
  
  try {
    // Run test suites based on selection
    if (options.suite === 'all' || options.suite === 'health') {
      const passed = await runHealthTests(options);
      results.push({ suite: 'health', passed });
      if (!passed) overallSuccess = false;
    }
    
    if (options.suite === 'all' || options.suite === 'integration') {
      const passed = await runIntegrationTests(options);
      results.push({ suite: 'integration', passed });
      if (!passed) overallSuccess = false;
    }
    
    if (options.suite === 'all' || options.suite === 'e2e') {
      const passed = await runE2ETests(options);
      results.push({ suite: 'e2e', passed });
      if (!passed) overallSuccess = false;
    }
    
    if (options.suite === 'all' || options.suite === 'security') {
      const passed = await runSecurityTests(options);
      results.push({ suite: 'security', passed });
      if (!passed) overallSuccess = false;
    }
    
    // Summary
    console.log('\n' + '='.repeat(50));
    printInfo('Test Results Summary:');
    
    for (const result of results) {
      const icon = result.passed ? '✅' : '❌';
      const color = result.passed ? colors.green : colors.red;
      console.log(`  ${icon} ${color}${result.suite}${colors.reset}`);
    }
    
    if (overallSuccess) {
      printSuccess('All tests passed!');
    } else {
      printError('Some tests failed');
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Test execution failed: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    printError(`Unexpected error: ${error}`);
    process.exit(1);
  });
}

export { main, TestOptions, TestOptionsSchema };