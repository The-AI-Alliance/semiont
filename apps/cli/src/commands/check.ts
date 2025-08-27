/**
 * Check Command - New Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType } from '../services/types.js';
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
  services: ServiceDeploymentInfo[],
  options: CheckOptions
): Promise<CommandResults> {
  const serviceResults: any[] = [];
  const commandStartTime = Date.now();
  
  // Create config for services
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
  };
  
  for (const serviceInfo of services) {
    const startTime = Date.now();
    
    try {
      // Create service instance
      const service = ServiceFactory.create(
        serviceInfo.name as ServiceName,
        serviceInfo.deploymentType as DeploymentType,
        config,
        {
          deploymentType: serviceInfo.deploymentType as DeploymentType
        } // Service config would come from project config
      );
      
      // Check the service
      const result = await service.check();
      
      // Record result
      serviceResults.push({
        service: serviceInfo.name,
        success: result.success,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
        status: result.status,
        stateVerified: result.stateVerified,
        stateMismatch: result.stateMismatch,
        health: result.health,
        resources: result.resources,
        logs: result.logs,
        metadata: result.metadata,
        error: result.error
      });
      
      // Display result
      if (!options.quiet) {
        const statusEmoji = 
          result.status === 'running' ? '✅' :
          result.status === 'stopped' ? '⛔' :
          result.status === 'unhealthy' ? '⚠️' :
          '❓';
        
        console.log(`${statusEmoji} ${serviceInfo.name}: ${result.status}`);
        
        if (result.status === 'running' || result.status === 'unhealthy') {
          // Show resource info
          if (result.resources?.pid) {
            console.log(`   PID: ${result.resources.pid}`);
          }
          if (result.resources?.containerId) {
            console.log(`   Container: ${result.resources.containerId}`);
          }
          if (result.resources?.port) {
            console.log(`   Port: ${result.resources.port}`);
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
      service: serviceInfo.name,
        success: false,
        duration: Date.now() - startTime,
        deployment: serviceInfo.deploymentType,
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
    
    const running = serviceResults.filter((r: any) => r.data.status === 'running').length;
    const stopped = serviceResults.filter((r: any) => r.data.status === 'stopped').length;
    const unhealthy = serviceResults.filter((r: any) => r.data.status === 'unhealthy').length;
    const unknown = serviceResults.filter((r: any) => r.data.status === 'unknown').length;
    
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
  
  // Build the CommandResults interface
  const commandResults: CommandResults = {
    command: 'check',
    environment: options.environment || 'unknown',
    timestamp: new Date(),
    duration: Date.now() - commandStartTime,
    services: serviceResults.map((r: any) => ({
      command: 'check',
      service: r.service,
      deploymentType: r.data.deployment,
      environment: options.environment || 'unknown',
      timestamp: new Date(),
      duration: r.data.duration,
      success: r.data.success,
      resourceId: { [r.data.deployment]: {} },
      status: r.data.status || 'unknown',
      metadata: r.data,
      error: r.data.error
    })),
    summary: {
      total: serviceResults.length,
      succeeded: serviceResults.filter((r: any) => r.data.success).length,
      failed: serviceResults.filter((r: any) => !r.data.success).length,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: false
    }
  };
  
  return commandResults;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const checkNewCommand = new CommandBuilder()
  .name('check-new')
  .description('Check service status using new service architecture')
  .schema(CheckOptionsSchema)
  .requiresServices(true)
  .handler(checkHandler)
  .build();