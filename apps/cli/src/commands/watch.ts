/**
 * Watch Command - Minimal updates for new architecture
 * 
 * This is a minimally updated version that uses the new service implementations
 * for checking status while keeping the dashboard functionality separate.
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import React from 'react';
import { render } from 'ink';
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
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName, DeploymentType, ServiceConfig } from '../services/types.js';
import { Config, CheckResult } from '../services/types.js';

// Import the React dashboard component dynamically to handle module loading
let DashboardApp: any;

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = z.object({
  environment: z.string().optional(),
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  noFollow: z.boolean().default(false),
  interval: z.number().int().positive().default(30),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  service: z.string().optional(),
  terminal: z.boolean().default(false),
  term: z.boolean().optional(),
  port: z.number().int().positive().default(3333),
}).transform((opts) => ({
  ...opts,
  terminal: opts.terminal || opts.term || false,
  term: undefined
}));

type WatchOptions = z.infer<typeof WatchOptionsSchema> & BaseCommandOptions;

// =====================================================================
// ENHANCED DATA SOURCE FOR NEW ARCHITECTURE
// =====================================================================

/**
 * Enhanced dashboard data source that uses the new service implementations
 */
class EnhancedDashboardDataSource {
  constructor(
    private environment: string,
    private serviceDeployments: ServiceDeploymentInfo[],
    private config: Config
  ) {}

  /**
   * Get dashboard data using the new service architecture
   */
  async getDashboardData() {
    const services = [];
    const logs: any[] = [];
    const metrics = [];

    // Use the new service implementations to check status
    for (const deployment of this.serviceDeployments) {
      try {
        const service = ServiceFactory.create(
          deployment.name as ServiceName,
          this.environment as DeploymentType,
          this.config,
          { deploymentType: this.environment as DeploymentType } as ServiceConfig
        );

        // Get status using the new check method
        const checkResult: CheckResult = await service.check();
        
        // Convert to dashboard format
        services.push({
          name: deployment.name.charAt(0).toUpperCase() + deployment.name.slice(1),
          status: this.mapStatus(checkResult.status),
          details: this.getDetails(checkResult),
          lastUpdated: new Date(),
          // Additional fields from checkResult
          resources: checkResult.resources,
          health: checkResult.health
        });

        // Add logs if available
        if (checkResult.logs?.recent) {
          checkResult.logs.recent.forEach(log => {
            logs.push({
              service: deployment.name,
              message: log,
              timestamp: new Date(),
              level: this.detectLogLevel(log)
            });
          });
        }

        // Add metrics if available
        if (checkResult.resources) {
          metrics.push({
            service: deployment.name,
            cpu: checkResult.resources.cpu,
            memory: checkResult.resources.memory,
            uptime: checkResult.resources.uptime,
            timestamp: new Date()
          });
        }

      } catch (error) {
        // Handle services that fail to check
        services.push({
          name: deployment.name,
          status: 'unknown',
          details: `Error: ${error}`,
          lastUpdated: new Date()
        });
      }
    }

    return {
      services,
      logs,
      metrics,
      lastUpdate: new Date(),
      isRefreshing: false
    };
  }

  private mapStatus(status: CheckResult['status']): 'healthy' | 'warning' | 'unhealthy' | 'unknown' {
    switch (status) {
      case 'running': return 'healthy';
      case 'stopped': return 'unhealthy';
      case 'unhealthy': return 'unhealthy';
      default: return 'unknown';
    }
  }

  private getDetails(checkResult: CheckResult): string {
    const parts = [];
    
    if (checkResult.health?.healthy) {
      parts.push('Healthy');
    }
    
    if (checkResult.resources?.pid) {
      parts.push(`PID: ${checkResult.resources.pid}`);
    }
    
    if (checkResult.resources?.containerId) {
      parts.push(`Container: ${checkResult.resources.containerId.slice(0, 12)}`);
    }
    
    if (checkResult.resources?.port) {
      parts.push(`Port: ${checkResult.resources.port}`);
    }
    
    return parts.join(', ') || checkResult.status;
  }

  private detectLogLevel(log: string): 'info' | 'warn' | 'error' {
    if (log.match(/\b(error|ERROR|Error)\b/)) return 'error';
    if (log.match(/\b(warning|WARNING|Warning|warn|WARN)\b/)) return 'warn';
    return 'info';
  }
}

// =====================================================================
// DASHBOARD LAUNCHER
// =====================================================================

async function launchDashboard(
  environment: string, 
  target: string, 
  serviceDeployments: ServiceDeploymentInfo[],
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
        const watchModule = await import('./watch-dashboard.js');
        DashboardApp = watchModule.default || watchModule.DashboardApp || watchModule;
        
        if (!DashboardApp || (typeof DashboardApp !== 'function' && !DashboardApp.$$typeof)) {
          throw new Error('Failed to load DashboardApp component');
        }
        
        // Create enhanced data source
        const dataSource = new EnhancedDashboardDataSource(environment, serviceDeployments, config);
        
        // Determine dashboard mode
        let mode: 'unified' | 'logs' | 'metrics' = 'unified';
        if (target === 'logs') mode = 'logs';
        else if (target === 'metrics') mode = 'metrics';
        
        // Create a wrapper component that provides data
        const EnhancedDashboard = () => {
          const [data, setData] = React.useState(null);
          
          React.useEffect(() => {
            const loadData = async () => {
              const newData = await dataSource.getDashboardData();
              setData(() => newData);
            };
            
            loadData();
            const timer = setInterval(loadData, interval * 1000);
            return () => clearInterval(timer);
          }, []);
          
          if (!data) return React.createElement('div', null, 'Loading...');
          
          return React.createElement(DashboardApp, {
            mode,
            data,
            refreshInterval: interval,
            environment
          });
        };
        
        // Launch the React/Ink dashboard
        const { waitUntilExit } = render(React.createElement(EnhancedDashboard));
        
        await waitUntilExit();
        const duration = Date.now() - startTime;
        resolve({
          duration,
          exitReason: 'user-quit'
        });
      } else {
        // Web dashboard mode
        const { WebDashboardServer } = await import('../lib/web-dashboard-server.js');
        
        // Create a custom server that uses the new service architecture
        class EnhancedWebDashboardServer extends WebDashboardServer {
          private override dataSource: EnhancedDashboardDataSource;
          
          constructor(environment: string, port: number, interval: number) {
            super(environment, port, interval);
            this.dataSource = new EnhancedDashboardDataSource(environment, serviceDeployments, config);
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
  serviceDeployments: ServiceDeploymentInfo[],
  options: WatchOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!;
  
  // Create config for the services
  const config: Config = {
    projectRoot: process.cwd(),
    environment: environment as any,
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
      services: serviceResults,
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

export const watchNewCommand = new CommandBuilder<WatchOptions>()
  .name('watch-new')
  .description('Monitor services using new architecture')
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
      '-s': '--service'
    }
  })
  .examples(
    'semiont watch-new -e production',
    'semiont watch-new -e staging --terminal',
    'semiont watch-new -e dev --target logs',
    'semiont watch-new -e local --interval 10 --port 4444'
  )
  .handler(watch)
  .build();

// Also export as default for compatibility
export default watchNewCommand;