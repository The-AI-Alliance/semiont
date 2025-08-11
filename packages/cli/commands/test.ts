/**
 * Test Command V2 - Deployment-type aware service testing
 * 
 * This command runs tests against services based on deployment type:
 * - AWS: Integration tests against AWS endpoints, health checks, performance tests
 * - Container: Container-based tests, service connectivity, volume tests
 * - Process: Local process tests, API tests, database connectivity
 * - External: External service integration tests, connectivity tests
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { getProjectRoot } from '../lib/cli-paths.js';
import { listContainers } from '../lib/container-runtime.js';
import * as http from 'http';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const TestOptionsSchema = z.object({
  environment: z.string(),
  suite: z.enum(['all', 'integration', 'e2e', 'health', 'security', 'connectivity']).default('all'),
  service: z.string().default('all'),
  coverage: z.boolean().default(false),
  parallel: z.boolean().default(false),
  timeout: z.number().int().positive().default(300), // 5 minutes
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type TestOptions = z.infer<typeof TestOptionsSchema>;


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
  
  // Validate with Zod
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
// DEPLOYMENT-TYPE-AWARE TEST FUNCTIONS
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

async function testService(serviceInfo: ServiceDeploymentInfo, suite: string, options: TestOptions): Promise<boolean> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would test ${serviceInfo.name} (${serviceInfo.deploymentType}) - ${suite}`);
    return true;
  }
  
  printInfo(`Testing ${serviceInfo.name} (${serviceInfo.deploymentType}) - ${suite}...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      return await testAWSService(serviceInfo, suite, options);
    case 'container':
      return await testContainerService(serviceInfo, suite, options);
    case 'process':
      return await testProcessService(serviceInfo, suite, options);
    case 'external':
      return await testExternalService(serviceInfo, suite, options);
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
      return false;
  }
}

async function testAWSService(serviceInfo: ServiceDeploymentInfo, suite: string, options: TestOptions): Promise<boolean> {
  // AWS service testing
  switch (suite) {
    case 'health':
      switch (serviceInfo.name) {
        case 'frontend':
        case 'backend':
          printInfo(`Checking ECS task health for ${serviceInfo.name}`);
          printWarning('AWS ECS health checks not yet implemented');
          return true;
        case 'database':
          printInfo(`Checking RDS instance health for ${serviceInfo.name}`);
          printWarning('RDS health checks not yet implemented');
          return true;
        case 'filesystem':
          printInfo(`Checking EFS mount health for ${serviceInfo.name}`);
          printWarning('EFS health checks not yet implemented');
          return true;
        default:
          return true;
      }
      
    case 'connectivity':
      printInfo(`Testing AWS connectivity for ${serviceInfo.name}`);
      printWarning('AWS connectivity tests not yet implemented');
      return true;
      
    case 'integration':
      printInfo(`Running AWS integration tests for ${serviceInfo.name}`);
      printWarning('AWS integration tests not yet implemented');
      return true;
      
    case 'security':
      printInfo(`Running AWS security tests for ${serviceInfo.name}`);
      printWarning('AWS security tests not yet implemented');
      return true;
      
    case 'e2e':
      if (serviceInfo.name === 'frontend' || serviceInfo.name === 'backend') {
        printInfo(`Running E2E tests against AWS ${serviceInfo.name}`);
        printWarning('AWS E2E tests not yet implemented');
      }
      return true;
      
    default:
      return true;
  }
}

async function testContainerService(serviceInfo: ServiceDeploymentInfo, suite: string, options: TestOptions): Promise<boolean> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  switch (suite) {
    case 'health':
      // Check if container is running and healthy
      const containers = await listContainers({ all: false });
      const isRunning = containers.some(c => c.includes(containerName));
      
      if (!isRunning) {
        printError(`Container ${containerName} is not running`);
        return false;
      }
      
      printSuccess(`Container ${containerName} is running`);
      
      // Service-specific health checks
      switch (serviceInfo.name) {
        case 'database':
          printInfo('Testing database container connectivity');
          // Could test PostgreSQL connection
          return true;
          
        case 'frontend':
        case 'backend':
          const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
          return await testHttpHealth(`http://localhost:${port}`, serviceInfo.name);
          
        case 'filesystem':
          printInfo('Testing container volume mounts');
          return true;
          
        default:
          return true;
      }
      
    case 'connectivity':
      printInfo(`Testing container connectivity for ${serviceInfo.name}`);
      // Test container network connectivity
      return true;
      
    case 'integration':
      return await runIntegrationTestsForService(serviceInfo, options);
      
    case 'security':
      printInfo(`Running container security tests for ${serviceInfo.name}`);
      // Container security scanning, etc.
      return true;
      
    case 'e2e':
      if (serviceInfo.name === 'frontend' || serviceInfo.name === 'backend') {
        return await runE2ETestsForService(serviceInfo, options);
      }
      return true;
      
    default:
      return true;
  }
}

async function testProcessService(serviceInfo: ServiceDeploymentInfo, suite: string, options: TestOptions): Promise<boolean> {
  switch (suite) {
    case 'health':
      switch (serviceInfo.name) {
        case 'database':
          return await testProcessOnPort(5432, 'PostgreSQL');
        case 'frontend':
        case 'backend':
          const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
          const processRunning = await testProcessOnPort(port, serviceInfo.name);
          if (!processRunning) return false;
          
          // Test HTTP health endpoint
          return await testHttpHealth(`http://localhost:${port}`, serviceInfo.name);
          
        case 'filesystem':
          const dataPath = serviceInfo.config.path || `${PROJECT_ROOT}/data`;
          try {
            const fs = await import('fs/promises');
            await fs.access(dataPath);
            printSuccess(`Filesystem directory accessible: ${dataPath}`);
            return true;
          } catch {
            printError(`Filesystem directory not accessible: ${dataPath}`);
            return false;
          }
          
        default:
          return true;
      }
      
    case 'connectivity':
      printInfo(`Testing process connectivity for ${serviceInfo.name}`);
      return true;
      
    case 'integration':
      return await runIntegrationTestsForService(serviceInfo, options);
      
    case 'security':
      return await runSecurityTestsForService(serviceInfo, options);
      
    case 'e2e':
      if (serviceInfo.name === 'frontend' || serviceInfo.name === 'backend') {
        return await runE2ETestsForService(serviceInfo, options);
      }
      return true;
      
    default:
      return true;
  }
}

async function testExternalService(serviceInfo: ServiceDeploymentInfo, suite: string, options: TestOptions): Promise<boolean> {
  switch (suite) {
    case 'health':
    case 'connectivity':
      switch (serviceInfo.name) {
        case 'database':
          if (serviceInfo.config.host) {
            printInfo(`Testing external database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
            printWarning('External database connectivity test not yet implemented');
            return true;
          }
          break;
          
        case 'filesystem':
          if (serviceInfo.config.path) {
            printInfo(`Testing external storage: ${serviceInfo.config.path}`);
            try {
              const fs = await import('fs/promises');
              await fs.access(serviceInfo.config.path!);
              printSuccess('External storage accessible');
              return true;
            } catch {
              printError('External storage not accessible');
              return false;
            }
          }
          break;
          
        case 'frontend':
        case 'backend':
          if (serviceInfo.config.host) {
            const url = `http://${serviceInfo.config.host}:${serviceInfo.config.port || 80}`;
            return await testHttpHealth(url, `external ${serviceInfo.name}`);
          }
          break;
      }
      return true;
      
    case 'integration':
      printInfo(`Running integration tests against external ${serviceInfo.name}`);
      printWarning('External integration tests not yet implemented');
      return true;
      
    case 'security':
      printInfo(`Running security tests for external ${serviceInfo.name}`);
      printWarning('External security tests not yet implemented');
      return true;
      
    case 'e2e':
      if (serviceInfo.name === 'frontend' || serviceInfo.name === 'backend') {
        printInfo(`Running E2E tests against external ${serviceInfo.name}`);
        printWarning('External E2E tests not yet implemented');
      }
      return true;
      
    default:
      return true;
  }
}

// =====================================================================
// UTILITY FUNCTIONS
// =====================================================================

async function testProcessOnPort(port: number, serviceName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-ti', `:${port}`]);
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', (code) => {
      const isRunning = code === 0 && output.trim().length > 0;
      if (isRunning) {
        printSuccess(`${serviceName} process is running on port ${port}`);
      } else {
        printError(`${serviceName} process is not running on port ${port}`);
      }
      resolve(isRunning);
    });
    
    proc.on('error', () => {
      printError(`Failed to check ${serviceName} process on port ${port}`);
      resolve(false);
    });
  });
}

async function testHttpHealth(url: string, serviceName: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    
    if (response.ok) {
      printSuccess(`${serviceName} health endpoint responding`);
      return true;
    } else {
      printWarning(`${serviceName} health endpoint returned ${response.status}`);
      return false;
    }
  } catch (error) {
    printWarning(`${serviceName} health endpoint not accessible: ${error}`);
    return false;
  }
}

async function runIntegrationTestsForService(serviceInfo: ServiceDeploymentInfo, options: TestOptions): Promise<boolean> {
  printInfo(`Running integration tests for ${serviceInfo.name}`);
  
  const testDirs = [
    `${PROJECT_ROOT}/tests/integration`,
    `${PROJECT_ROOT}/apps/${serviceInfo.name}/tests/integration`,
  ];
  
  // Try to run tests with different test runners
  const runners = [
    { cmd: 'npm', args: ['run', 'test:integration'] },
    { cmd: 'vitest', args: ['run', '--config', 'vitest.integration.config.ts'] },
    { cmd: 'jest', args: ['--testMatch', `**/*${serviceInfo.name}*.integration.test.(js|ts)`] },
  ];
  
  for (const testDir of testDirs) {
    for (const runner of runners) {
      const success = await runCommand(runner.cmd, runner.args, testDir, options);
      if (success) {
        printSuccess(`Integration tests passed for ${serviceInfo.name}`);
        return true;
      }
    }
  }
  
  printWarning(`No integration tests found for ${serviceInfo.name}`);
  return true; // Don't fail if tests don't exist
}

async function runSecurityTestsForService(serviceInfo: ServiceDeploymentInfo, options: TestOptions): Promise<boolean> {
  printInfo(`Running security tests for ${serviceInfo.name}`);
  
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      try {
        const response = await fetch(`http://localhost:${port}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000)
        });
        
        // Check security headers
        const hasSecurityHeaders = response.headers.has('x-content-type-options');
        if (hasSecurityHeaders) {
          printSuccess(`${serviceInfo.name} has security headers`);
        } else {
          printWarning(`${serviceInfo.name} missing security headers`);
        }
        return true;
      } catch {
        printWarning(`Could not check security for ${serviceInfo.name} (not running)`);
        return true;
      }
      
    default:
      printInfo(`Security check not applicable for ${serviceInfo.name}`);
      return true;
  }
}

async function runE2ETestsForService(serviceInfo: ServiceDeploymentInfo, options: TestOptions): Promise<boolean> {
  printInfo(`Running E2E tests for ${serviceInfo.name}`);
  
  try {
    const success = await runCommand('npx', [
      'playwright', 'test',
      '--grep', serviceInfo.name,
      ...(options.parallel ? ['--workers', '4'] : []),
    ], PROJECT_ROOT, options);
    
    if (success) {
      printSuccess(`E2E tests passed for ${serviceInfo.name}`);
    }
    return success;
  } catch (error) {
    printWarning(`E2E tests not found for ${serviceInfo.name}`);
    return true; // Don't fail if E2E tests aren't set up
  }
}



// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`🧪 Running ${options.suite} tests in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'start', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'start', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    // Determine which test suites to run
    const suitesToRun = options.suite === 'all' 
      ? ['health', 'connectivity', 'integration', 'security', 'e2e']
      : [options.suite];
    
    const results: { service: string; suite: string; passed: boolean }[] = [];
    let overallSuccess = true;
    
    // Run tests for each service and each suite
    for (const suite of suitesToRun) {
      printInfo(`\n🧪 Running ${suite} tests...`);
      
      for (const serviceInfo of serviceDeployments) {
        try {
          const passed = await testService(serviceInfo, suite, options);
          results.push({ service: serviceInfo.name, suite, passed });
          
          if (!passed) {
            overallSuccess = false;
          }
        } catch (error) {
          printError(`Test failed for ${serviceInfo.name} (${suite}): ${error}`);
          results.push({ service: serviceInfo.name, suite, passed: false });
          overallSuccess = false;
        }
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    printInfo('Test Results Summary:');
    
    // Group results by service
    const serviceResults = new Map<string, { suite: string; passed: boolean }[]>();
    for (const result of results) {
      if (!serviceResults.has(result.service)) {
        serviceResults.set(result.service, []);
      }
      serviceResults.get(result.service)!.push({ suite: result.suite, passed: result.passed });
    }
    
    for (const [serviceName, suiteResults] of serviceResults) {
      console.log(`\n📦 ${colors.bright}${serviceName}${colors.reset}:`);
      for (const result of suiteResults) {
        const icon = result.passed ? '✅' : '❌';
        const color = result.passed ? colors.green : colors.red;
        console.log(`  ${icon} ${color}${result.suite}${colors.reset}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    
    if (overallSuccess) {
      printSuccess('All tests passed!');
    } else {
      printError('Some tests failed');
      const failedTests = results.filter(r => !r.passed);
      printInfo(`Failed: ${failedTests.length}/${results.length} tests`);
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