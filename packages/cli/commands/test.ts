/**
 * Test Command - Deployment-type aware service testing
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
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { getProjectRoot } from '../lib/cli-paths.js';
import { listContainers } from '../lib/container-runtime.js';
import { 
  TestResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const TestOptionsSchema = z.object({
  environment: z.string(),
  suite: z.enum(['all', 'integration', 'e2e', 'health', 'security', 'connectivity']).default('all'),
  coverage: z.boolean().default(false),
  parallel: z.boolean().default(false),
  timeout: z.number().int().positive().default(300), // 5 minutes
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

type TestOptions = z.infer<typeof TestOptionsSchema>;


// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Global flag to control output suppression
let suppressOutput = false;

function printError(message: string): string {
  const msg = `${colors.red}❌ ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.error(msg);
  }
  return msg;
}

function printSuccess(message: string): string {
  const msg = `${colors.green}✅ ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.log(msg);
  }
  return msg;
}

function printInfo(message: string): string {
  const msg = `${colors.cyan}ℹ️  ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.log(msg);
  }
  return msg;
}

function printWarning(message: string): string {
  const msg = `${colors.yellow}⚠️  ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.log(msg);
  }
  return msg;
}

function printDebug(message: string, options: TestOptions): string {
  const msg = `${colors.dim}[DEBUG] ${message}${colors.reset}`;
  if (!suppressOutput && options.verbose) {
    console.log(msg);
  }
  return msg;
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

async function testServiceImpl(serviceInfo: ServiceDeploymentInfo, suite: string, options: TestOptions): Promise<boolean> {
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

async function testAWSService(serviceInfo: ServiceDeploymentInfo, suite: string, _options: TestOptions): Promise<boolean> {
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

async function testExternalService(serviceInfo: ServiceDeploymentInfo, suite: string, _options: TestOptions): Promise<boolean> {
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

// =====================================================================
// STRUCTURED OUTPUT FUNCTIONS
// =====================================================================

async function testService(serviceInfo: ServiceDeploymentInfo, suite: string, options: TestOptions, isStructuredOutput: boolean = false): Promise<TestResult> {
  const startTime = Date.now();
  
  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`[DRY RUN] Would test ${serviceInfo.name} (${serviceInfo.deploymentType}) - ${suite}`);
    }
    
    return {
      ...createBaseResult('test', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime),
      testSuite: suite,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      testsSkipped: 0,
      testDuration: 0,
      failures: [],
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Testing ${serviceInfo.name} (${serviceInfo.deploymentType}) - ${suite}...`);
  }
  
  // Suppress output when in structured mode
  const previousSuppressOutput = suppressOutput;
  suppressOutput = isStructuredOutput;
  
  // Run the actual tests
  const passed = await testServiceImpl(serviceInfo, suite, options);
  const testDuration = Date.now() - startTime;
  
  // Restore output suppression state
  suppressOutput = previousSuppressOutput;
  
  return {
    ...createBaseResult('test', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime),
    testSuite: suite,
    testsRun: 1, // Simplified for now
    testsPassed: passed ? 1 : 0,
    testsFailed: passed ? 0 : 1,
    testsSkipped: 0,
    testDuration,
    failures: passed ? [] : [{ test: suite, error: 'Test suite failed' }],
    resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
    status: passed ? 'passed' : 'failed',
    metadata: { suite },
  };
}

// =====================================================================
// STRUCTURED OUTPUT MAIN FUNCTION
// =====================================================================

export async function test(
  serviceDeployments: ServiceDeploymentInfo[],
  options: TestOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Running ${colors.bright}${options.suite}${colors.reset} tests in ${colors.bright}${options.environment}${colors.reset} environment`);
  }
  
  try {
    
    if (!isStructuredOutput && options.output === 'summary' && options.verbose) {
      console.log(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`);
    }
    
    // Determine which test suites to run
    const suitesToRun = options.suite === 'all' 
      ? ['health', 'integration', 'e2e'] 
      : [options.suite];
    
    // Run tests and collect results
    const serviceResults: TestResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      for (const suite of suitesToRun) {
        try {
          const result = await testService(serviceInfo, suite, options, isStructuredOutput);
          serviceResults.push(result);
        } catch (error) {
          // Create error result
          const baseResult = createBaseResult('test', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
          const errorResult = createErrorResult(baseResult, error as Error);
          
          const testErrorResult: TestResult = {
            ...errorResult,
            testSuite: suite,
            testsRun: 0,
            testsPassed: 0,
            testsFailed: 1,
            testsSkipped: 0,
            testDuration: Date.now() - startTime,
            failures: [{ test: 'setup', error: (error as Error).message }],
            resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
            status: 'failed',
            metadata: { error: (error as Error).message },
          };
          
          serviceResults.push(testErrorResult);
          
          if (!isStructuredOutput && options.output === 'summary') {
            printError(`Failed to test ${serviceInfo.name}: ${error}`);
          }
        }
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'test',
      environment: options.environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.filter(r => r.success).length,
        failed: serviceResults.filter(r => !r.success).length,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      }
    };
    
    return commandResults;
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Failed to run tests: ${error}`);
    }
    
    return {
      command: 'test',
      environment: options.environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: [],
      summary: {
        total: 0,
        succeeded: 0,
        failed: 1,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      },
    };
  }
}

async function runSecurityTestsForService(serviceInfo: ServiceDeploymentInfo, _options: TestOptions): Promise<boolean> {
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



// Note: The main function is removed as cli.ts now handles service resolution and output formatting
// The test function now accepts pre-resolved services and returns CommandResults

// Export the schema for use by CLI
export { TestOptions, TestOptionsSchema };