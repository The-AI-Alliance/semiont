/**
 * Exec Command - Service-based implementation
 */

import { z } from 'zod';
import { printError, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { CommandResults } from '../lib/command-results-class.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { Config, ServiceName, DeploymentType, ExecOptions } from '../services/types.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const ExecCommandOptionsSchema = z.object({
  environment: z.string().optional(),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  quiet: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  service: z.string(), // Required - must specify which service to exec into
  command: z.string(), // The command to execute
  interactive: z.boolean().default(false),
  tty: z.boolean().default(false),
  user: z.string().optional(),
  workingDirectory: z.string().optional(),
  shell: z.string().optional(),
  captureOutput: z.boolean().default(true),
  timeout: z.number().optional(),
});

type ExecCommandOptions = z.infer<typeof ExecCommandOptionsSchema> & BaseCommandOptions;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function execHandler(
  options: ExecCommandOptions,
  services: ServiceDeploymentInfo[]
): Promise<CommandResults> {
  const results = new CommandResults();
  
  // Exec only works with a single service
  if (services.length === 0) {
    throw new Error('No service specified for exec');
  }
  if (services.length > 1) {
    throw new Error('Exec can only be used with a single service');
  }
  
  const serviceInfo = services[0];
  
  // Create config for service
  const config: Config = {
    projectRoot: PROJECT_ROOT,
    environment: options.environment as any || 'dev',
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  
  const startTime = Date.now();
  
  try {
    // Create service instance
    const service = ServiceFactory.create(
      serviceInfo.name as ServiceName,
      serviceInfo.deploymentType as DeploymentType,
      config,
      {
        deploymentType: serviceInfo.deploymentType as DeploymentType
      }
    );
    
    // Build exec options
    const execOptions: ExecOptions = {
      interactive: options.interactive,
      tty: options.tty,
      ...(options.user && { user: options.user }),
      ...(options.workingDirectory && { workingDirectory: options.workingDirectory }),
      ...(options.shell && { shell: options.shell }),
      captureOutput: options.captureOutput,
      ...(options.timeout && { timeout: options.timeout }),
      env: {} // Could be extended to pass custom env vars
    };
    
    // Execute the command
    const result = await service.exec(options.command, execOptions);
    
    // Record result
    results.addResult(serviceInfo.name, {
      success: result.success,
      duration: Date.now() - startTime,
      deployment: serviceInfo.deploymentType,
      command: result.command,
      exitCode: result.execution?.exitCode,
      workingDirectory: result.execution?.workingDirectory,
      user: result.execution?.user,
      shell: result.execution?.shell,
      interactive: result.execution?.interactive,
      tty: result.execution?.tty,
      stdout: result.output?.stdout,
      stderr: result.output?.stderr,
      truncated: result.output?.truncated,
      containerId: result.execution?.containerId,
      instanceId: result.execution?.instanceId,
      sessionId: result.execution?.sessionId,
      streaming: result.streaming,
      security: result.security,
      error: result.error,
      metadata: result.metadata
    });
    
    // Display result
    if (!options.quiet) {
      const icon = result.success ? '✅' : '❌';
      const statusText = result.success ? 'executed' : 'failed';
      console.log(`${icon} ${serviceInfo.name} (${serviceInfo.deploymentType}): Command ${statusText}`);
      
      // Show execution details
      if (result.execution) {
        if (result.execution.workingDirectory) {
          console.log(`   📁 Working Dir: ${result.execution.workingDirectory}`);
        }
        if (result.execution.user) {
          console.log(`   👤 User: ${result.execution.user}`);
        }
        if (result.execution.shell) {
          console.log(`   🐚 Shell: ${result.execution.shell}`);
        }
        if (result.execution.exitCode !== undefined && result.execution.exitCode !== 0) {
          console.log(`   ⚠️  Exit Code: ${result.execution.exitCode}`);
        }
        if (result.execution.duration) {
          console.log(`   ⏱️  Duration: ${result.execution.duration}ms`);
        }
        if (result.execution.containerId) {
          console.log(`   🐳 Container ID: ${result.execution.containerId}`);
        }
        if (result.execution.instanceId) {
          console.log(`   ☁️  Instance: ${result.execution.instanceId}`);
        }
        if (result.execution.sessionId) {
          console.log(`   🔗 Session: ${result.execution.sessionId}`);
        }
      }
      
      // Show security info
      if (result.security) {
        const securityDetails = [];
        if (result.security.authenticated) securityDetails.push('authenticated');
        if (result.security.authorization) securityDetails.push(result.security.authorization);
        if (result.security.audit) securityDetails.push('audited');
        if (result.security.sudoRequired) securityDetails.push('sudo');
        
        if (securityDetails.length > 0) {
          console.log(`   🔐 Security: ${securityDetails.join(', ')}`);
        }
      }
      
      // Show streaming support
      if (result.streaming?.supported) {
        console.log(`   📡 Streaming: Supported`);
        if (result.streaming.websocketUrl) {
          console.log(`      WebSocket: ${result.streaming.websocketUrl}`);
        }
        if (result.streaming.streamId) {
          console.log(`      Stream ID: ${result.streaming.streamId}`);
        }
      }
      
      // Show output (if not interactive and output was captured)
      if (!options.interactive && result.output) {
        if (result.output.stdout) {
          const lines = result.output.stdout.split('\n');
          const maxLines = options.verbose ? lines.length : 10;
          const displayLines = lines.slice(0, maxLines);
          
          if (displayLines.length > 0 && displayLines.some(l => l.trim())) {
            console.log('\n📤 Output:');
            displayLines.forEach(line => {
              if (line.trim()) console.log(`   ${line}`);
            });
            
            if (lines.length > maxLines) {
              console.log(`   ... (${lines.length - maxLines} more lines)`);
            }
          }
        }
        
        if (result.output.stderr) {
          const lines = result.output.stderr.split('\n');
          const displayLines = lines.slice(0, 5);
          
          if (displayLines.length > 0 && displayLines.some(l => l.trim())) {
            console.log('\n⚠️  Errors:');
            displayLines.forEach(line => {
              if (line.trim()) console.log(`   ${line}`);
            });
            
            if (lines.length > 5) {
              console.log(`   ... (${lines.length - 5} more lines)`);
            }
          }
        }
        
        if (result.output.truncated) {
          printWarning(`Output was truncated (max ${result.output.maxBytes} bytes)`);
        }
      }
      
      // Show recommendations for failed commands or external services
      if (!result.success) {
        if (result.error) {
          printError(`Error: ${result.error}`);
        }
        
        if (serviceInfo.deploymentType === 'external' && result.metadata?.recommendations) {
          console.log('\n💡 Recommendations:');
          result.metadata.recommendations.forEach((rec: string) => {
            console.log(`   • ${rec}`);
          });
        } else if (serviceInfo.deploymentType === 'process' && options.interactive) {
          console.log('\n💡 Note: Interactive execution is not supported in process platform.');
          console.log('   Consider using the container platform for interactive sessions.');
        }
      }
    }
    
    // Interactive mode message
    if (options.interactive && result.success && !options.quiet) {
      console.log('\n📝 Interactive session completed');
    }
    
  } catch (error) {
    results.addResult(serviceInfo.name, {
      success: false,
      duration: Date.now() - startTime,
      deployment: serviceInfo.deploymentType,
      command: options.command,
      error: error instanceof Error ? error.message : String(error)
    });
    
    if (!options.quiet) {
      printError(`Failed to execute command in ${serviceInfo.name}: ${error}`);
    }
  }
  
  if (options.dryRun && !options.quiet) {
    printInfo('\n🔍 This was a dry run. No actual command was executed.');
  }
  
  return results;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const execNewCommand = new CommandBuilder('exec-new')
  .description('Execute commands within running services')
  .schema(ExecCommandOptionsSchema)
  .requiresServices(true)
  .handler(execHandler)
  .build();