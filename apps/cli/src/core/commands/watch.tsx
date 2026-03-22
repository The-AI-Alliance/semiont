/**
 * Watch Command
 *
 * Starts the web dashboard for real-time monitoring of services, logs, and metrics.
 */

import { z } from 'zod';
import { printInfo, printError, setSuppressOutput } from '../io/cli-logger.js';
import { type ServicePlatformInfo } from '../service-resolver.js';
import { type PlatformType } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';

import { Platform } from '../platform.js';
import { AWSPlatform } from '../../platforms/aws/platform.js';
import { ContainerPlatform } from '../../platforms/container/platform.js';
import { PosixPlatform } from '../../platforms/posix/platform.js';

import { colors } from '../io/cli-colors.js';
import { DashboardDataSource } from '../dashboard/dashboard-data.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = BaseOptionsSchema.extend({
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  noFollow: z.boolean().default(false),
  interval: z.number().int().positive().default(30),
  service: z.string().optional(),
  port: z.number().int().positive().default(3333),
});

export type WatchOptions = z.output<typeof WatchOptionsSchema>;


// =====================================================================
// DASHBOARD LAUNCHER
// =====================================================================

async function launchDashboard(
  environment: string,
  serviceDeployments: ServicePlatformInfo[],
  envConfig: import('@semiont/core').EnvironmentConfig,
  interval: number,
  port: number
): Promise<{ duration: number; exitReason: string }> {
  const startTime = Date.now();

  return new Promise(async (resolve) => {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      setTimeout(() => resolve({ duration: 100, exitReason: 'user-quit' }), 100);
      return;
    }

    try {
      const { WebDashboardServer } = await import('../dashboard/web-dashboard-server.js');

      class EnhancedWebDashboardServer extends WebDashboardServer {
        constructor(environment: string, port: number, interval: number) {
          super(environment, port, interval);
          this.dataSource = new DashboardDataSource(environment, serviceDeployments, envConfig);
        }

        async getDashboardData() {
          return this.dataSource.getDashboardData();
        }
      }

      const server = new EnhancedWebDashboardServer(environment, port, interval);
      await server.start();

      const stop = () => {
        server.stop();
        resolve({ duration: Date.now() - startTime, exitReason: 'user-quit' });
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    } catch (error) {
      console.error('Dashboard error:', error);
      resolve({ duration: Date.now() - startTime, exitReason: 'error' });
    }
  });
}

// =====================================================================
// MAIN WATCH FUNCTION
// =====================================================================

export async function watch(
  serviceDeployments: ServicePlatformInfo[],
  options: WatchOptions,
  envConfig: import('@semiont/core').EnvironmentConfig
  
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = envConfig._metadata?.environment;
  if (!environment) {
    throw new Error('Environment is required in envConfig._metadata');
  }
  setSuppressOutput(isStructuredOutput);

  // Group services by platform for credential validation
  const servicesByPlatform = new Map<PlatformType, ServicePlatformInfo[]>();
  for (const service of serviceDeployments) {
    const existing = servicesByPlatform.get(service.platform) || [];
    existing.push(service);
    servicesByPlatform.set(service.platform, existing);
  }

  // Validate credentials for each platform
  const failedPlatforms: { platform: PlatformType; error: string; action?: string; services: ServicePlatformInfo[] }[] = [];

  for (const [platform, services] of servicesByPlatform) {
    let strategy: Platform;
    switch (platform) {
      case 'aws':      strategy = new AWSPlatform(); break;
      case 'container': strategy = new ContainerPlatform(); break;
      case 'posix':    strategy = new PosixPlatform(); break;
      default: continue;
    }

    const validation = await strategy.validateCredentials(environment);
    if (!validation.valid) {
      failedPlatforms.push({
        platform,
        error: validation.error || `${platform} credentials are not configured`,
        action: validation.requiresAction,
        services
      });
    }
  }

  if (failedPlatforms.length > 0) {
    if (!isStructuredOutput) {
      for (const failure of failedPlatforms) {
        const platformName = failure.platform.charAt(0).toUpperCase() + failure.platform.slice(1);
        printError(`${colors.red}✗ ${platformName} credentials check failed${colors.reset}`);
        printError(`  ${failure.error}`);
        if (failure.action) {
          printInfo(`\n${colors.bright}To fix this issue:${colors.reset}`);
          printInfo(`  Run: ${colors.cyan}${failure.action}${colors.reset}`);
          printInfo(`  Then try the watch command again`);
        }
      }
    }

    const errorResults = failedPlatforms.flatMap(failure =>
      failure.services.map(serviceInfo => ({
        entity: serviceInfo.name,
        platform: serviceInfo.platform,
        success: false,
        error: `Cannot start watch: ${failure.error}`,
        metadata: {
          credentialError: true,
          platform: failure.platform,
          requiresAction: failure.action
        }
      }))
    );

    return {
      command: 'watch',
      environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      results: errorResults,
      summary: { total: errorResults.length, succeeded: 0, failed: errorResults.length, warnings: 0 },
      executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun }
    };
  }

  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Starting web dashboard for ${colors.bright}${environment}${colors.reset} environment`);
    printInfo(`Dashboard will be available at http://localhost:${options.port}`);
    printInfo(`Target: ${options.target}, Refresh interval: ${options.interval}s`);
  }

  let sessionDuration = 0;
  let exitReason = 'completed';

  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo('[DRY RUN] Would launch web dashboard');
    }
    exitReason = 'dry-run';
  } else {
    const result = await launchDashboard(environment, serviceDeployments, envConfig, options.interval, options.port);
    sessionDuration = result.duration;
    exitReason = result.exitReason;
  }

  const serviceResults = serviceDeployments.map(serviceInfo => ({
    entity: serviceInfo.name,
    platform: serviceInfo.platform,
    success: true,
    status: 'session-ended',
    metadata: { mode: options.target, refreshInterval: options.interval, sessionDuration, exitReason },
  }));

  return {
    command: 'watch',
    environment,
    timestamp: new Date(),
    duration: sessionDuration || Date.now() - startTime,
    results: serviceResults,
    summary: { total: serviceResults.length, succeeded: serviceResults.length, failed: 0, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun }
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const watchCommand = new CommandBuilder()
  .name('watch')
  .description('Monitor services using new architecture')
  .schema(WatchOptionsSchema)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args(withBaseArgs({
    '--service': { type: 'string', description: 'Service name or "all" for all services' },
    '--target': { type: 'string', description: 'What to watch (all, logs, metrics, services)' },
    '--no-follow': { type: 'boolean', description: 'Do not follow new logs' },
    '--interval': { type: 'number', description: 'Refresh interval in seconds' },
    '--port': { type: 'number', description: 'Port for web dashboard (default: 3333)' },
  }, {
    '-t': '--target',
    '-i': '--interval',
    '-s': '--service'
  }))
  .examples(
    'semiont watch -e production',
    'semiont watch -e dev --target logs',
    'semiont watch -e local --interval 10 --port 4444'
  )
  .handler(watch)
  .build();