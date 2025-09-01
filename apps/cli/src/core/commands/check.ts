/**
 * Check Command
 * 
 * Performs health checks and status verification for running services.
 * This command provides detailed diagnostics about service health, resource
 * usage, and connectivity across all platforms.
 * 
 * Workflow:
 * 1. Loads service state to identify what should be running
 * 2. Performs platform-specific health checks
 * 3. Validates service dependencies are accessible
 * 4. Checks resource usage against limits
 * 5. Reports detailed status and any issues found
 * 
 * Options:
 * - --all: Check all services in the environment
 * - --deep: Perform thorough health checks including dependencies
 * - --wait: Keep checking until services are healthy or timeout
 * - --json: Output results in JSON format for automation
 * 
 * Platform Behavior:
 * - Process: Checks if process is alive, validates PID, monitors resources
 * - Container: Inspects container status, checks logs for errors
 * - AWS: Queries ECS/Lambda status, CloudWatch metrics
 * - External: Pings endpoints, validates API connectivity
 * - Mock: Returns simulated health status for testing
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../io/cli-logger.js';
import { type ServicePlatformInfo } from '../platform-resolver.js';
import { CommandResults } from '../command-results.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';


// Import new service architecture
import { ServiceFactory } from '../../services/service-factory.js';
import { ServiceName } from '../service-discovery.js';
import { Platform } from '../platform-resolver.js';
import { PlatformStrategy } from '../platform-strategy.js';
import { PlatformResources } from '../../platforms/platform-resources.js';
import { Config } from '../cli-config.js';
import { parseEnvironment } from '../environment-validator.js';

// Imports needed for performAWSCheck
import { Service } from '../../services/types.js';
import { HandlerRegistry } from '../handlers/registry.js';
import { HandlerContextBuilder } from '../handlers/context.js';
import { CheckHandlerResult } from '../handlers/types.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a check/status operation
 */
export interface CheckResult {
  entity: ServiceName | string;
  platform: Platform | string;
  success: boolean;
  checkTime: Date;
  status: 'running' | 'stopped' | 'unhealthy' | 'unknown';
  stateVerified: boolean; // Did saved state match reality?
  stateMismatch?: {
    expected: any;
    actual: any;
    reason: string;
  };
  health?: {
    endpoint?: string;
    statusCode?: number;
    responseTime?: number;
    healthy: boolean;
    details?: Record<string, any>;
  };
  logs?: {
    recent?: string[];
    errors?: number;
    warnings?: number;
  };
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const CheckOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
});

type CheckOptions = z.output<typeof CheckOptionsSchema>;

// =====================================================================
// CHECK IMPLEMENTATION
// =====================================================================

async function performCheck(service: Service, platform: PlatformStrategy): Promise<CheckResult> {
  const serviceType = platform.determineServiceType(service);
  
  const registry = HandlerRegistry.getInstance();
  const descriptor = registry.getDescriptor(platform.getPlatformName(), `check-${serviceType}`);
  
  if (!descriptor) {
    return {
      entity: service.name,
      platform: platform.getPlatformName(),
      success: false,
      checkTime: new Date(),
      status: 'unknown',
      stateVerified: false,
      metadata: {
        error: `No check handler registered for service type: ${serviceType}`
      }
    };
  }

  const contextExtensions = await platform.buildHandlerContextExtensions(
    service, 
    descriptor.requiresDiscovery || false
  );
  
  const context = HandlerContextBuilder.extend(
    HandlerContextBuilder.buildBaseContext(service, platform.getPlatformName()),
    contextExtensions
  );
  
  const result = await descriptor.handler(context) as CheckHandlerResult;
  
  return {
    entity: service.name,
    platform: platform.getPlatformName(),
    success: result.success,
    checkTime: new Date(),
    status: result.status,
    stateVerified: true,
    resources: result.platformResources,
    health: result.health,
    logs: result.logs,
    metadata: {
      ...result.metadata,
      serviceType
    }
  };
}

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function checkHandler(
  services: ServicePlatformInfo[],
  options: CheckOptions
): Promise<CommandResults<CheckResult>> {
  const serviceResults: CheckResult[] = [];
  const commandStartTime = Date.now();
  
  // Create config for services
  const parsedEnv = parseEnvironment(options.environment);
  if (options.verbose) {
    console.log(`[DEBUG] options.environment: ${options.environment}`);
    console.log(`[DEBUG] parseEnvironment result: ${parsedEnv}`);
  }
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parsedEnv,
    verbose: options.verbose,
    quiet: options.quiet,
    forceDiscovery: options.forceDiscovery,
  };
  
  for (const serviceInfo of services) {
    // Get the platform outside try block so it's accessible in catch
    const { PlatformFactory } = await import('../../platforms/index.js');
    const platform = PlatformFactory.getPlatform(serviceInfo.platform);
    const actualPlatformName = platform.getPlatformName();
    
    try {
      // Create service instance to act as ServiceContext
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.platform,
        config,
        {
          platform: serviceInfo.platform
        } // Service config would come from project config
      );
      
      const result = await performCheck(service, platform);
      
      // Record result directly - no conversion needed!
      serviceResults.push(result);
      
      // Display result
      if (!options.quiet) {
        const statusEmoji = 
          result.status === 'running' ? '✅' :
          result.status === 'stopped' ? '⛔' :
          result.status === 'unhealthy' ? '⚠️' :
          '❓';
        
        console.log(`${statusEmoji} ${serviceInfo.name}: ${result.status}`);
        
        if (result.status === 'running' || result.status === 'unhealthy') {
          // Show resource info based on platform
          if (result.resources) {
            if (result.resources.platform === 'posix' && result.resources.data.pid) {
              console.log(`   PID: ${result.resources.data.pid}`);
            }
            if (result.resources.platform === 'container' && result.resources.data.containerId) {
              console.log(`   Container: ${result.resources.data.containerId}`);
            }
            if (result.resources.platform === 'posix' && result.resources.data.port) {
              console.log(`   Port: ${result.resources.data.port}`);
            }
          }
          
          // Show health info
          if (result.health) {
            const healthEmoji = result.health.healthy ? '💚' : '💔';
            console.log(`   Health: ${healthEmoji} ${result.health.healthy ? 'Healthy' : 'Unhealthy'}`);
            if (result.health.endpoint) {
              console.log(`   Endpoint: ${result.health.endpoint}`);
            }
            if (result.health.responseTime) {
              console.log(`   Response time: ${result.health.responseTime}ms`);
            }
          }
          
          // Show state verification
          if (!result.stateVerified && result.stateMismatch) {
            printWarning(`   ⚠️  State mismatch: ${result.stateMismatch.reason}`);
          }
          
          // Show logs if available (remove confusing error/warning counts)
          if (result.logs?.recent && result.logs.recent.length > 0) {
            if (options.verbose) {
              console.log('   Recent logs:');
              result.logs.recent.slice(0, 3).forEach(log => {
                console.log(`     ${log}`);
              });
            }
          }
        }
        
        // Show metadata in verbose mode
        if (options.verbose && result.metadata) {
          console.log('   Metadata:', JSON.stringify(result.metadata, null, 2));
        }
      }
      
    } catch (error) {
      serviceResults.push({
        entity: serviceInfo.name as ServiceName,
        platform: actualPlatformName as Platform,  // Use actual platform name
        success: false,
        checkTime: new Date(),
        status: 'unknown',
        stateVerified: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      if (!options.quiet) {
        printError(`Failed to check ${serviceInfo.name}: ${error}`);
      }
    }
  }
  
  // Summary for multiple services
  if (!options.quiet && services.length > 1) {
    console.log('\n📊 Summary:');
    
    const running = serviceResults.filter(r => r.status === 'running').length;
    const stopped = serviceResults.filter(r => r.status === 'stopped').length;
    const unhealthy = serviceResults.filter(r => r.status === 'unhealthy').length;
    const unknown = serviceResults.filter(r => r.status === 'unknown').length;
    
    console.log(`   Running: ${running}`);
    console.log(`   Stopped: ${stopped}`);
    if (unhealthy > 0) console.log(`   Unhealthy: ${unhealthy}`);
    if (unknown > 0) console.log(`   Unknown: ${unknown}`);
    
    if (running === services.length) {
      printSuccess('All services are running! 🎉');
    } else if (stopped === services.length) {
      printInfo('All services are stopped.');
    } else {
      printWarning('Some services are not running.');
    }
  }
  
  // Return results directly - no conversion needed!
  return {
    command: 'check',
    environment: options.environment || 'unknown',
    timestamp: new Date(),
    duration: Date.now() - commandStartTime,
    results: serviceResults,  // Rich types preserved!
    summary: {
      total: serviceResults.length,
      succeeded: serviceResults.filter(r => r.success).length,
      failed: serviceResults.filter(r => !r.success).length,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: false
    }
  } as CommandResults<CheckResult>;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const checkCommand = new CommandBuilder()
  .name('check-new')
  .description('Check service status using new service architecture')
  .schema(CheckOptionsSchema)
  .requiresServices(true)
  .requiresEnvironment(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
  }))
  .handler(checkHandler)
  .build();