/**
 * Watch Command - Interactive monitoring with structured output support
 * 
 * This command provides real-time monitoring through an interactive dashboard.
 * When the session ends, it returns structured output about the monitoring session.
 */

import React from 'react';
import { render } from 'ink';
import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { 
  WatchResult, 
  CommandResults, 
  createBaseResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

// Re-export the React component from watch.tsx
import { default as WatchDashboard } from './watch.tsx';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('all'),
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  noFollow: z.boolean().default(false),
  interval: z.number().int().positive().default(5),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

type WatchOptions = z.infer<typeof WatchOptionsSchema>;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Global flag to control output suppression
let suppressOutput = false;

function printError(message: string): void {
  if (!suppressOutput) {
    console.error(`${colors.red}❌ ${message}${colors.reset}`);
  }
}

function printSuccess(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
  }
}

function printInfo(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
  }
}

function printDebug(message: string, options: WatchOptions): void {
  if (!suppressOutput && options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// DASHBOARD LAUNCHER
// =====================================================================

async function launchDashboard(
  environment: string, 
  target: string, 
  service: string,
  interval: number
): Promise<{ duration: number; exitReason: string }> {
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    // The watch.tsx file handles the actual dashboard rendering
    // We need to invoke it as a child process or import and use it
    
    // For now, we'll use a simplified approach
    // In production, this would launch the full React/Ink dashboard
    
    if (suppressOutput) {
      // In structured output mode, simulate a brief session
      setTimeout(() => {
        resolve({
          duration: 1000,
          exitReason: 'structured-output-mode'
        });
      }, 1000);
    } else {
      // Launch the actual interactive dashboard
      const { spawn } = require('child_process');
      const watchProcess = spawn(process.execPath, [
        new URL('./watch.tsx', import.meta.url).pathname,
        environment,
        target === 'logs' ? 'logs' : target === 'metrics' ? 'metrics' : 'unified',
        service !== 'all' ? service : ''
      ].filter(Boolean), {
        stdio: 'inherit'
      });
      
      watchProcess.on('close', (code: number) => {
        const duration = Date.now() - startTime;
        const exitReason = code === 0 ? 'user-quit' : `error-code-${code}`;
        resolve({ duration, exitReason });
      });
      
      // Handle process termination
      process.on('SIGINT', () => {
        watchProcess.kill('SIGINT');
      });
    }
  });
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

export async function watch(options: WatchOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  // Suppress output for structured formats
  const previousSuppressOutput = suppressOutput;
  suppressOutput = isStructuredOutput;
  
  try {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Starting watch dashboard for ${colors.bright}${options.environment}${colors.reset} environment`);
      printInfo(`Target: ${options.target}, Refresh interval: ${options.interval}s`);
      printInfo('Press "q" to quit, "r" to refresh');
    }
    
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'watch', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'watch', options.environment);
    
    // Get deployment information for monitoring context
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    if (!isStructuredOutput && options.output === 'summary' && options.verbose) {
      printDebug(`Monitoring services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
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
        options.environment,
        options.target,
        options.service,
        options.interval
      );
      sessionDuration = result.duration;
      exitReason = result.exitReason;
    }
    
    // Create watch results for each monitored service
    const serviceResults: WatchResult[] = serviceDeployments.map(serviceInfo => {
      const baseResult = createBaseResult('watch', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
      
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
      environment: options.environment,
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
    suppressOutput = previousSuppressOutput;
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

export async function main(options: WatchOptions): Promise<void> {
  try {
    const results = await watch(options);
    
    // Handle structured output
    if (options.output !== 'summary') {
      const { formatResults } = await import('../lib/output-formatter.js');
      const formatted = formatResults(results, options.output);
      console.log(formatted);
      return;
    }
    
    // For summary format, the dashboard has already shown everything
    // Just show a completion message
    if (!options.dryRun) {
      printSuccess('Watch session completed');
      printInfo(`Session duration: ${Math.round(results.duration / 1000)}s`);
    }
    
  } catch (error) {
    printError(`Watch operation failed: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse basic arguments for standalone execution
  const options: WatchOptions = {
    environment: process.argv[2] || 'local',
    service: 'all',
    target: 'all',
    noFollow: false,
    interval: 5,
    verbose: false,
    dryRun: false,
    output: 'summary'
  };
  
  main(options).catch(error => {
    printError(`Unexpected error: ${error}`);
    process.exit(1);
  });
}

export { WatchOptions, WatchOptionsSchema };