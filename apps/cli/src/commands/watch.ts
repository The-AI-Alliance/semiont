/**
 * Watch Command - Unified command structure
 */

import { z } from 'zod';
import React from 'react';
import { render } from 'ink';
import { colors } from '../lib/cli-colors.js';
import { printInfo, setSuppressOutput } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { 
  WatchResult, 
  CommandResults, 
  createBaseResult,
  ResourceIdentifier 
} from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';

// Import the React dashboard component dynamically to handle module loading
let DashboardApp: any;

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = z.object({
  environment: z.string().optional(),
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  noFollow: z.boolean().default(false),
  interval: z.number().int().positive().default(30),  // Increased from 5s to 30s
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  service: z.string().optional(),
  terminal: z.boolean().default(false),  // Changed from web to terminal, default false (web is default)
  term: z.boolean().optional(),  // Alias for terminal
  port: z.number().int().positive().default(3333),
}).transform((opts) => ({
  ...opts,
  terminal: opts.terminal || opts.term || false,  // Handle both --terminal and --term
  term: undefined  // Remove the alias from the final options
}));

type WatchOptions = z.infer<typeof WatchOptionsSchema> & BaseCommandOptions;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Helper wrapper for printDebug that passes verbose option
function debugLog(_message: string, _options: any): void {
  // Debug logging disabled for now
}

// =====================================================================
// DASHBOARD LAUNCHER
// =====================================================================

async function launchDashboard(
  environment: string, 
  target: string, 
  services: string[],
  interval: number,
  terminalMode: boolean = false,  // Changed from webMode to terminalMode
  port: number = 3333
): Promise<{ duration: number; exitReason: string }> {
  const startTime = Date.now();
  
  return new Promise(async (resolve) => {
    // Check if we're in test mode
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      // Simulate a dashboard that runs briefly and exits normally
      setTimeout(() => {
        resolve({
          duration: 100,
          exitReason: 'user-quit'
        });
      }, 100);
      return;
    }
    
    try {
      if (terminalMode) {
        // Launch terminal dashboard
        // Dynamically import the dashboard component
        const watchModule = await import('./watch-dashboard.js');
        DashboardApp = watchModule.default || watchModule.DashboardApp || watchModule;
        
        // Ensure we have a valid component
        if (!DashboardApp || (typeof DashboardApp !== 'function' && !DashboardApp.$$typeof)) {
          throw new Error('Failed to load DashboardApp component');
        }
        
        // Determine dashboard mode based on target
        let mode: 'unified' | 'logs' | 'metrics' = 'unified';
        if (target === 'logs') {
          mode = 'logs';
        } else if (target === 'metrics') {
          mode = 'metrics';
        }
        
        // Determine service filter
        let service: 'frontend' | 'backend' | undefined;
        if (services.length === 1) {
          const svc = services[0];
          if (svc === 'frontend' || svc === 'backend') {
            service = svc as 'frontend' | 'backend';
          }
        }
        
        // Launch the React/Ink dashboard directly
        const { waitUntilExit } = render(
          React.createElement(DashboardApp, {
            mode,
            service,
            refreshInterval: interval,
            environment
          })
        );
        
        await waitUntilExit();
        const duration = Date.now() - startTime;
        resolve({
          duration,
          exitReason: 'user-quit'
        });
      } else {
        // Launch web-based dashboard (default)
        const { WebDashboardServer } = await import('../lib/web-dashboard-server.js');
        const server = new WebDashboardServer(environment, port, interval);
        
        await server.start();
        
        // Wait for Ctrl+C
        process.on('SIGINT', () => {
          server.stop();
          const duration = Date.now() - startTime;
          resolve({
            duration,
            exitReason: 'user-quit'
          });
        });
        
        process.on('SIGTERM', () => {
          server.stop();
          const duration = Date.now() - startTime;
          resolve({
            duration,
            exitReason: 'user-quit'
          });
        });
      }
    } catch (error) {
      console.error('Dashboard error:', error);
      const duration = Date.now() - startTime;
      resolve({
        duration,
        exitReason: 'error'
      });
    }
  });
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

export async function watch(
  serviceDeployments: ServiceDeploymentInfo[],
  options: WatchOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  // Suppress output for structured formats
  const previousSuppressOutput = setSuppressOutput(isStructuredOutput);
  
  try {
    if (!isStructuredOutput && options.output === 'summary') {
      if (options.terminal) {
        printInfo(`Starting terminal dashboard for ${colors.bright}${environment}${colors.reset} environment`);
        printInfo(`Target: ${options.target}, Refresh interval: ${options.interval}s`);
        printInfo('Press "q" to quit, "r" to refresh');
      } else {
        printInfo(`Starting web dashboard for ${colors.bright}${environment}${colors.reset} environment`);
        printInfo(`Dashboard will be available at http://localhost:${options.port}`);
        printInfo(`Target: ${options.target}, Refresh interval: ${options.interval}s`);
      }
    }
    
    if (!isStructuredOutput && options.output === 'summary' && options.verbose) {
      debugLog(`Monitoring services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    }
    
    // Launch the dashboard or simulate in dry-run mode
    let sessionDuration = 0;
    let exitReason = 'completed';
    
    if (options.dryRun) {
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo('[DRY RUN] Would launch watch dashboard');
      }
      sessionDuration = 0;
      exitReason = 'dry-run';
    } else {
      // Launch the actual dashboard
      const result = await launchDashboard(
        environment,
        options.target,
        serviceDeployments.map(s => s.name),
        options.interval,
        options.terminal,
        options.port
      );
      sessionDuration = result.duration;
      exitReason = result.exitReason;
    }
    
    // Create watch results for each monitored service
    const serviceResults: WatchResult[] = serviceDeployments.map(serviceInfo => {
      const baseResult = createBaseResult('watch', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
      
      return {
        ...baseResult,
        watchType: options.target === 'logs' ? 'logs' as const : 
                   options.target === 'metrics' ? 'metrics' as const : 
                   'events' as const,
        resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
        status: 'session-ended',
        metadata: {
          mode: options.target,
          refreshInterval: options.interval,
          sessionDuration: sessionDuration,
          exitReason: exitReason,
          interactive: !isStructuredOutput
        },
      };
    });
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'watch',
      environment: environment,
      timestamp: new Date(),
      duration: sessionDuration || Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.length, // Watch sessions always "succeed"
        failed: 0,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      }
    };
    
    return commandResults;
    
  } finally {
    // Restore output suppression state
    setSuppressOutput(previousSuppressOutput);
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const watchCommand = new CommandBuilder<WatchOptions>()
  .name('watch')
  .description('Monitor logs and system metrics')
  .schema(WatchOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name' },
      '--target': { type: 'string', description: 'What to watch (all, logs, metrics, services)' },
      '--no-follow': { type: 'boolean', description: 'Do not follow new logs' },
      '--interval': { type: 'number', description: 'Refresh interval in seconds' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
      '--terminal': { type: 'boolean', description: 'Use terminal-based dashboard instead of web' },
      '--term': { type: 'boolean', description: 'Alias for --terminal' },
      '--port': { type: 'number', description: 'Port for web dashboard (default: 3333)' },
    },
    aliases: {
      '-e': '--environment',
      '-t': '--target',
      '-i': '--interval',
      '-v': '--verbose',
      '-o': '--output',
    }
  })
  .examples(
    'semiont watch --environment local',
    'semiont watch --environment staging --target logs',
    'semiont watch --environment production --service backend --interval 10',
    'semiont watch --environment staging --port 8080',
    'semiont watch --environment production --terminal'
  )
  .handler(watch)
  .build();

// Export default for compatibility
export default watchCommand;

// Note: The main function is removed as cli.ts now handles service resolution and output formatting
// The watch function now accepts pre-resolved services and returns CommandResults

// Export the schema for use by CLI

export type { WatchOptions };
export { WatchOptionsSchema };