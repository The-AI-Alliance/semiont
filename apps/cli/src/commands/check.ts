/**
 * Check Command - New Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../lib/platform-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from '../services/service-interface.js';
import { CheckResult } from '../services/check-service.js';
import { Config } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const CheckOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().optional(),
  all: z.boolean().default(false),
});

type CheckOptions = z.output<typeof CheckOptionsSchema>;

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
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
  };
  
  for (const serviceInfo of services) {
    
    try {
      // Create service instance
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.platform,
        config,
        {
          platform: serviceInfo.platform
        } // Service config would come from project config
      );
      
      // Check the service
      const result = await service.check();
      
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
            if (result.resources.platform === 'process' && result.resources.data.pid) {
              console.log(`   PID: ${result.resources.data.pid}`);
            }
            if (result.resources.platform === 'container' && result.resources.data.containerId) {
              console.log(`   Container: ${result.resources.data.containerId}`);
            }
            if (result.resources.platform === 'process' && result.resources.data.port) {
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
          
          // Show logs summary if available
          if (result.logs) {
            if (result.logs.errors && result.logs.errors > 0) {
              console.log(`   ❌ Errors: ${result.logs.errors}`);
            }
            if (result.logs.warnings && result.logs.warnings > 0) {
              console.log(`   ⚠️  Warnings: ${result.logs.warnings}`);
            }
            if (options.verbose && result.logs.recent) {
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
        platform: serviceInfo.platform,
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

export const checkNewCommand = new CommandBuilder()
  .name('check-new')
  .description('Check service status using new service architecture')
  .schema(CheckOptionsSchema)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
  }))
  .handler(checkHandler)
  .build();