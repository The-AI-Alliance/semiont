/**
 * Test Command - Simplified to delegate to platforms
 * 
 * Commands delegate to platforms, which handle all test logic
 */

import { CommandBuilder } from '../lib/command-definition.js';
import { z } from 'zod';
import { printInfo, printSuccess, printError } from '../lib/cli-logger.js';
import { ServiceName } from '../services/service-interface.js';
import { CommandResults } from '../lib/command-results.js';
import { ServicePlatformInfo } from '../lib/platform-resolver.js';
import { Platform } from '../lib/platform-resolver.js';
import { ServiceFactory } from '../services/service-factory.js';
import { PlatformFactory } from '../platforms/index.js';
import { Config } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';

// =====================================================================
// TYPE DEFINITIONS
// =====================================================================

const TestOptionsSchema = z.object({
  suite: z.enum(['all', 'health', 'unit', 'component', 'integration', 'e2e', 'security', 'connectivity']).optional(),
  watch: z.boolean().optional(),
  coverage: z.boolean().optional(),
  verbose: z.boolean().optional(),
  bail: z.boolean().optional(),
  timeout: z.number().optional()
});

export type TestOptions = z.infer<typeof TestOptionsSchema>;

export interface TestResult {
  entity: ServiceName | string;
  platform: Platform;
  suite: string;
  success: boolean;
  testTime: Date;
  duration?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  coverage?: number;
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// MAIN HANDLER - Delegates to platforms  
// =====================================================================

async function testHandler(
  services: ServicePlatformInfo[],
  options: TestOptions & { environment?: string; verbose?: boolean; quiet?: boolean; dryRun?: boolean }
): Promise<CommandResults<TestResult>> {
  const testOptions = options as TestOptions;
  const { quiet, verbose, environment = 'development', dryRun } = options;
  const suite = testOptions.suite || 'health';
  
  // Create config
  const config: Config = {
    projectRoot: process.cwd(),
    environment: parseEnvironment(environment),
    verbose: verbose || false,
    quiet: quiet || false,
    dryRun: dryRun
  };
  
  if (!quiet) {
    printInfo(`Running ${suite} tests for ${services.length} service(s)`);
  }
  
  const results: TestResult[] = [];
  const failures: string[] = [];
  
  for (const serviceInfo of services) {
    const testTime = new Date();
    
    try {
      // Get the platform strategy
      const platform = PlatformFactory.getPlatform(serviceInfo.platform);
      
      // Create service instance to act as ServiceContext
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.platform,
        config,
        { ...serviceInfo.config, platform: serviceInfo.platform }
      );
      
      // Platform handles the test command with service as context
      const result = await platform.test(service, testOptions);
      
      results.push({
        ...result,
        entity: serviceInfo.name,
        platform: serviceInfo.platform,
        suite,
        testTime,
        duration: Date.now() - testTime.getTime()
      });
      
      if (result.success) {
        printSuccess(`✓ ${serviceInfo.name} ${suite} tests passed`);
      } else {
        failures.push(serviceInfo.name);
        printError(`✗ ${serviceInfo.name} ${suite} tests failed`);
        if (testOptions.bail) {
          break;
        }
      }
    } catch (error) {
      failures.push(serviceInfo.name);
      results.push({
        entity: serviceInfo.name,
        platform: serviceInfo.platform,
        suite,
        success: false,
        testTime,
        error: (error as Error).message
      });
      
      printError(`Error testing ${serviceInfo.name}: ${(error as Error).message}`);
      if (testOptions.bail) {
        break;
      }
    }
  }
  
  // Summary
  if (!quiet) {
    if (failures.length === 0) {
      printSuccess(`All ${suite} tests passed!`);
    } else {
      printError(`${failures.length} service(s) failed ${suite} tests: ${failures.join(', ')}`);
    }
  }
  
  return {
    command: 'test',
    environment: environment,
    timestamp: new Date(),
    duration: 0, // Already completed
    results,
    summary: {
      total: services.length,
      succeeded: services.length - failures.length,
      failed: failures.length,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: dryRun || false
    }
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const testCommand = new CommandBuilder()
  .name('test')
  .description('Run tests for services')
  .schema(TestOptionsSchema)
  .requiresServices(true)
  .handler(testHandler)
  .build();