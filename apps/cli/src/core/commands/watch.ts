/**
 * Watch Command
 * 
 * Monitors services in real-time, providing live updates on status, logs, and metrics.
 * This command offers both a terminal dashboard view and web-based monitoring interface
 * for comprehensive service observation.
 * 
 * Workflow:
 * 1. Establishes monitoring connections to services
 * 2. Starts real-time data collection (logs, metrics, events)
 * 3. Renders dashboard with live updates
 * 4. Handles user interactions (filtering, drilling down)
 * 5. Optionally starts web dashboard server
 * 
 * Options:
 * - --all: Watch all services
 * - --logs: Include log streaming
 * - --metrics: Show performance metrics
 * - --interval: Update interval in seconds
 * - --web: Start web dashboard on specified port
 * - --filter: Filter logs by pattern
 * 
 * Dashboard Features:
 * - Service status indicators (running, stopped, error)
 * - Real-time log streaming with filtering
 * - Resource usage graphs (CPU, memory, network)
 * - Health check status and history
 * - Interactive controls for service management
 */

import { z } from 'zod';
import { printInfo, setSuppressOutput } from '../io/cli-logger.js';
import { type ServicePlatformInfo, type Platform } from '../platform-resolver.js';
import { CommandResults, createBaseResult } from '../command-results.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';

// Import new service architecture
import { ServiceName } from '../service-discovery.js';
import { PlatformResources } from '../../platforms/platform-resources.js';
import { Config } from '../cli-config.js';
import { parseEnvironment } from '../environment-validator.js';

import { colors } from '../io/cli-colors.js';
import React from 'react';
import { render } from 'ink';
import { DashboardDataSource } from '../dashboard/dashboard-data.js';

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a watch operation
 */
export interface WatchResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  status?: string;  // Optional status for legacy commands
  watchType: 'logs' | 'metrics' | 'events';
  streamUrl?: string;
  logLines?: Array<{
    timestamp: Date;
    level: string;
    message: string;
    source?: string;
  }>;
  metrics?: Array<{
    name: string;
    value: number;
    unit: string;
    timestamp: Date;
  }>;
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}


// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = BaseOptionsSchema.extend({
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  noFollow: z.boolean().default(false),
  interval: z.number().int().positive().default(30),
  service: z.string().optional(),
  terminal: z.boolean().default(false),
  term: z.boolean().optional(),
  port: z.number().int().positive().default(3333),
}).transform((opts) => ({
  ...opts,
  terminal: opts.terminal || opts.term || false,
  term: undefined
}));

type WatchOptions = z.output<typeof WatchOptionsSchema>;

// =====================================================================
// ENHANCED DATA SOURCE FOR NEW ARCHITECTURE
// =====================================================================

// Enhanced data source now lives in dashboard-data.ts
// The EnhancedDashboardDataSource class has been moved to dashboard-data.ts
// and renamed to DashboardDataSource


// =====================================================================
// DASHBOARD LAUNCHER
// =====================================================================

async function launchDashboard(
  environment: string, 
  target: string, 
  serviceDeployments: ServicePlatformInfo[],
  config: Config,
  interval: number,
  terminalMode: boolean = false,
  port: number = 3333
): Promise<{ duration: number; exitReason: string }> {
  const startTime = Date.now();
  
  return new Promise(async (resolve) => {
    // Check if we're in test mode
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
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
        // Terminal dashboard mode
        const { DashboardApp: DashboardComponent } = await import('../dashboard/dashboard-layouts.js');
        
        // Create data source using the new architecture
        const dataSource = new DashboardDataSource(environment, serviceDeployments, config);
        
        // Determine dashboard mode
        let mode: 'unified' | 'logs' | 'metrics' = 'unified';
        if (target === 'logs') mode = 'logs';
        else if (target === 'metrics') mode = 'metrics';
        
        // Launch the React/Ink dashboard directly
        const { waitUntilExit } = render(React.createElement(DashboardComponent, {
          mode,
          dataSource,
          refreshInterval: interval,
          environment
        }));
        
        await waitUntilExit();
        const duration = Date.now() - startTime;
        resolve({
          duration,
          exitReason: 'user-quit'
        });
      } else {
        // Web dashboard mode
        const { WebDashboardServer } = await import('../dashboard/web-dashboard-server.js');
        
        // Create a custom server that uses the new service architecture
        class EnhancedWebDashboardServer extends WebDashboardServer {
          constructor(environment: string, port: number, interval: number) {
            super(environment, port, interval);
            // Override the parent's dataSource with our enhanced version
            this.dataSource = new DashboardDataSource(environment, serviceDeployments, config);
          }
          
          async getDashboardData() {
            return this.dataSource.getDashboardData();
          }
        }
        
        const server = new EnhancedWebDashboardServer(environment, port, interval);
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
// MAIN WATCH FUNCTION
// =====================================================================

export async function watch(
  serviceDeployments: ServicePlatformInfo[],
  options: WatchOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!;
  
  // Debug: Log received service deployments
  if (options.verbose) {
    console.log('[DEBUG] Watch command received serviceDeployments:', JSON.stringify(serviceDeployments, null, 2));
  }
  
  // Create config for the services
  const config: Config = {
    projectRoot: process.cwd(),
    environment: parseEnvironment(environment),
    verbose: options.verbose,
    quiet: isStructuredOutput,
    dryRun: options.dryRun
  };
  
  // Suppress output for structured formats
  const previousSuppressOutput = setSuppressOutput(isStructuredOutput);
  
  try {
    if (!isStructuredOutput && options.output === 'summary') {
      if (options.terminal) {
        printInfo(`Starting terminal dashboard for ${colors.bright}${environment}${colors.reset} environment`);
        printInfo(`Target: ${options.target}, Refresh interval: ${options.interval}s`);
        printInfo('Press "q" to quit, "r" to refresh');
        printInfo('Using new service architecture for status checks');
      } else {
        printInfo(`Starting web dashboard for ${colors.bright}${environment}${colors.reset} environment`);
        printInfo(`Dashboard will be available at http://localhost:${options.port}`);
        printInfo(`Target: ${options.target}, Refresh interval: ${options.interval}s`);
        printInfo('Using new service architecture for status checks');
      }
    }
    
    // Launch the dashboard or simulate in dry-run mode
    let sessionDuration = 0;
    let exitReason = 'completed';
    
    if (options.dryRun) {
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo('[DRY RUN] Would launch watch dashboard with new service architecture');
      }
      sessionDuration = 0;
      exitReason = 'dry-run';
    } else {
      // Launch the enhanced dashboard
      const result = await launchDashboard(
        environment,
        options.target,
        serviceDeployments,
        config,
        options.interval,
        options.terminal,
        options.port
      );
      sessionDuration = result.duration;
      exitReason = result.exitReason;
    }
    
    // Create watch results for each monitored service
    const serviceResults: WatchResult[] = serviceDeployments.map(serviceInfo => {
      const baseResult = createBaseResult('watch', serviceInfo.name, serviceInfo.platform, environment, startTime);
      
      return {
        ...baseResult,
        entity: baseResult.service,
        watchType: options.target === 'logs' ? 'logs' as const : 
                   options.target === 'metrics' ? 'metrics' as const : 
                   'events' as const,
        status: 'session-ended',
        metadata: {
          mode: options.target,
          refreshInterval: options.interval,
          sessionDuration: sessionDuration,
          exitReason: exitReason,
          interactive: !isStructuredOutput,
          usingNewArchitecture: true
        },
      };
    });
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'watch',
      environment: environment,
      timestamp: new Date(),
      duration: sessionDuration || Date.now() - startTime,
      results: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.length,
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

export const watchCommand = new CommandBuilder()
  .name('watch-new')
  .description('Monitor services using new architecture')
  .schema(WatchOptionsSchema)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
    '--target': { type: 'string', description: 'What to watch (all, logs, metrics, services)' },
    '--no-follow': { type: 'boolean', description: 'Do not follow new logs' },
    '--interval': { type: 'number', description: 'Refresh interval in seconds' },
    '--terminal': { type: 'boolean', description: 'Use terminal-based dashboard instead of web' },
    '--term': { type: 'boolean', description: 'Alias for --terminal' },
    '--port': { type: 'number', description: 'Port for web dashboard (default: 3333)' },
  }, {
    '-t': '--target',
    '-i': '--interval',
    '-s': '--service'
  }))
  .examples(
    'semiont watch-new -e production',
    'semiont watch-new -e staging --terminal',
    'semiont watch-new -e dev --target logs',
    'semiont watch-new -e local --interval 10 --port 4444'
  )
  .handler(watch)
  .build();