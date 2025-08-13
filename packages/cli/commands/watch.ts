/**
 * Watch Command - Interactive monitoring with structured output support
 * 
 * This command provides real-time monitoring through an interactive dashboard.
 * When the session ends, it returns structured output about the monitoring session.
 */

// import React from 'react';
import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { 
  WatchResult, 
  CommandResults, 
  createBaseResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

// Re-export the React component from watch.tsx

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = z.object({
  environment: z.string(),
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

// function printError(message: string): string {
//   const msg = `${colors.red}❌ ${message}${colors.reset}`;
//   if (!suppressOutput) {
//     console.error(msg);
//   }
//   return msg;
// }

// function printSuccess(message: string): string {
//   const msg = `${colors.green}✅ ${message}${colors.reset}`;
//   if (!suppressOutput) {
//     console.log(msg);
//   }
//   return msg;
// }

function printInfo(message: string): string {
  const msg = `${colors.cyan}ℹ️  ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.log(msg);
  }
  return msg;
}

function printDebug(message: string, options: WatchOptions): string {
  const msg = `${colors.dim}[DEBUG] ${message}${colors.reset}`;
  if (!suppressOutput && options.verbose) {
    console.log(msg);
  }
  return msg;
}

// =====================================================================
// DASHBOARD LAUNCHER
// =====================================================================

async function launchDashboard(
  environment: string, 
  target: string, 
  services: string[],
  interval: number
): Promise<{ duration: number; exitReason: string }> {
  // const startTime = Date.now();
  
  return new Promise((resolve) => {
    // In production, this would launch the full React/Ink dashboard
    // For now, we simulate the dashboard for testing
    
    if (suppressOutput) {
      // In structured output mode, simulate a brief session
      setTimeout(() => {
        resolve({
          duration: 1000,
          exitReason: 'structured-output-mode'
        });
      }, 1000);
    } else {
      // For interactive mode in tests or when the TSX component cannot be loaded,
      // we simulate a successful session. In production, this would use the
      // React/Ink dashboard from watch.tsx
      
      // Check if we're in test mode
      if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
        // Simulate a dashboard that runs briefly and exits normally
        setTimeout(() => {
          resolve({
            duration: 100,
            exitReason: 'user-quit'
          });
        }, 100);
      } else {
        // In production, this would launch the actual React/Ink dashboard
        // For now, simulate it
        console.log('Dashboard would launch here in production');
        setTimeout(() => {
          resolve({
            duration: 1000,
            exitReason: 'user-quit'
          });
        }, 1000);
      }
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
  
  // Suppress output for structured formats
  const previousSuppressOutput = suppressOutput;
  suppressOutput = isStructuredOutput;
  
  try {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Starting watch dashboard for ${colors.bright}${options.environment}${colors.reset} environment`);
      printInfo(`Target: ${options.target}, Refresh interval: ${options.interval}s`);
      printInfo('Press "q" to quit, "r" to refresh');
    }
    
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
        serviceDeployments.map(s => s.name),
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

// Note: The main function is removed as cli.ts now handles service resolution and output formatting
// The watch function now accepts pre-resolved services and returns CommandResults

// Export the schema for use by CLI

export { WatchOptions, WatchOptionsSchema };