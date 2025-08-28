/**
 * Exec Command
 * 
 * Executes commands or scripts within the context of running services.
 * This command provides interactive access and script execution capabilities
 * for debugging, maintenance, and operational tasks.
 * 
 * Workflow:
 * 1. Verifies service is running
 * 2. Establishes connection to service context
 * 3. Executes command with service environment
 * 4. Streams output back to user
 * 5. Returns command exit status
 * 
 * Options:
 * - --interactive: Open interactive shell session
 * - --script: Execute a script file
 * - --env: Additional environment variables
 * - --workdir: Working directory for command execution
 * - --user: User context for execution (platform-specific)
 * 
 * Platform Behavior:
 * - Process: Executes in process working directory with same environment
 * - Container: Uses docker/podman exec to run inside container
 * - AWS: Uses ECS exec or Systems Manager for remote execution
 * - External: Not supported (external services are not controllable)
 * - Mock: Simulates command execution for testing
 */

import { z } from 'zod';
import { printError, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../platforms/platform-resolver.js';
import { CommandResults } from '../commands/command-results.js';
import { CommandBuilder } from '../commands/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../commands/base-options-schema.js';

// Import new service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from '../services/service-interface.js';
import { Config } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';
import type { Platform } from '../platforms/platform-resolver.js';
import type { PlatformResources } from '../platforms/platform-resources.js';

const PROJECT_ROOT = process.env.SEMIONT_ROOT || process.cwd();

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of an exec operation
 */
export interface ExecResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  execTime: Date;
  command: string; // The command that was executed
  execution?: {
    // Execution context
    workingDirectory?: string;
    user?: string; // User context (e.g., root, app, www-data)
    shell?: string; // Shell used (bash, sh, etc.)
    interactive?: boolean; // Whether this is an interactive session
    tty?: boolean; // Whether a TTY is allocated
    
    // Process information
    pid?: number; // Process ID of executed command
    exitCode?: number; // Exit code of the command
    signal?: string; // Termination signal if killed
    duration?: number; // Execution time in milliseconds
    
    // Environment
    environment?: Record<string, string>; // Environment variables
    containerId?: string; // For container exec
    instanceId?: string; // For cloud exec (ECS, EC2)
    sessionId?: string; // For SSM or other session-based exec
  };
  output?: {
    stdout?: string; // Standard output
    stderr?: string; // Standard error
    combined?: string; // Combined output (if captured together)
    truncated?: boolean; // Whether output was truncated due to size
    maxBytes?: number; // Maximum bytes captured
  };
  streaming?: {
    supported: boolean; // Can stream output in real-time?
    websocketUrl?: string; // WebSocket URL for streaming
    streamId?: string; // Stream identifier
  };
  security?: {
    authenticated?: boolean; // Whether authentication was required
    authorization?: string; // Authorization method used
    sudoRequired?: boolean; // Did command require sudo?
    audit?: boolean; // Whether execution is audited/logged
  };
  resources?: PlatformResources;  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Options for exec operation
 */
export interface ExecOptions {
  workingDirectory?: string;
  user?: string;
  shell?: string;
  interactive?: boolean;
  tty?: boolean;
  env?: Record<string, string>;
  timeout?: number;
  captureOutput?: boolean;
  stream?: boolean;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const ExecCommandOptionsSchema = BaseOptionsSchema.extend({
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

type ExecCommandOptions = z.output<typeof ExecCommandOptionsSchema>;

// =====================================================================
// COMMAND HANDLER
// =====================================================================

async function execHandler(
  services: ServicePlatformInfo[],
  options: ExecCommandOptions
): Promise<CommandResults<ExecResult>> {
  const serviceResults: ExecResult[] = [];
  
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
    environment: parseEnvironment(options.environment),
    verbose: options.verbose,
    quiet: options.quiet,
    dryRun: options.dryRun,
  };
  const startTime = Date.now();
  
  try {
    // Create service instance
    const service = ServiceFactory.create(
      serviceInfo.name as ServiceName,
      serviceInfo.platform,
      config,
      {
        platform: serviceInfo.platform
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
    
    // Get the platform strategy
    const { PlatformFactory } = await import('../platforms/index.js');
    const platform = PlatformFactory.getPlatform(serviceInfo.platform);
    
    // Platform handles the exec command
    const result = await platform.exec(service, options.command, execOptions);
    
    // Record result directly - no conversion needed!
    serviceResults.push(result);
    
    // Display result
    if (!options.quiet) {
      const icon = result.success ? '✅' : '❌';
      const statusText = result.success ? 'executed' : 'failed';
      console.log(`${icon} ${serviceInfo.name} (${serviceInfo.platform}): Command ${statusText}`);
      
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
        
        if (serviceInfo.platform === 'external' && result.metadata?.recommendations) {
          console.log('\n💡 Recommendations:');
          result.metadata.recommendations.forEach((rec: string) => {
            console.log(`   • ${rec}`);
          });
        } else if (serviceInfo.platform === 'process' && options.interactive) {
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
    serviceResults.push({
      entity: serviceInfo.name as ServiceName,
      platform: serviceInfo.platform,
      success: false,
      execTime: new Date(),
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
  
  // Return results directly - no conversion needed!
  return {
    command: 'exec',
    environment: options.environment || 'default',
    timestamp: new Date(),
    duration: Date.now() - startTime,
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
      dryRun: options.dryRun || false
    }
  } as CommandResults<ExecResult>;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const execCommand = new CommandBuilder()
  .name('exec-new')
  .description('Execute commands within running services')
  .schema(ExecCommandOptionsSchema)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service to execute command in', required: true },
    '--command': { type: 'string', description: 'The command to execute', required: true },
    '--interactive': { type: 'boolean', description: 'Interactive mode' },
    '--tty': { type: 'boolean', description: 'Allocate a TTY' },
    '--user': { type: 'string', description: 'User to run command as' },
    '--working-directory': { type: 'string', description: 'Working directory' },
    '--shell': { type: 'string', description: 'Shell to use' },
    '--capture-output': { type: 'boolean', description: 'Capture command output', default: true },
    '--timeout': { type: 'number', description: 'Command timeout in seconds' },
  }, {
    '-c': '--command',
    '-i': '--interactive',
    '-u': '--user',
    '-w': '--working-directory',
  }))
  .handler(execHandler)
  .build();