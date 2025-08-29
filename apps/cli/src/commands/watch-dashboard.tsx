/**
 * Semiont Watch Command - Interactive Dashboard
 * 
 * Provides real-time monitoring of services, logs, and metrics through
 * a modern terminal-based dashboard interface built with React/Ink.
 */

import React from 'react';
import { render } from 'ink';
import { DashboardApp, DashboardMode } from '../dashboard/dashboard-layouts.js';

import { getAvailableEnvironments } from '../platforms/platform-resolver.js';

// Argument parsing with environment support
function parseArgs(): { environment: string; mode: DashboardMode } {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
  }
  
  const environment = args[0];
  if (!environment) {
    console.error('Environment is required');
    showHelp();
  }
  
  const availableEnvironments = getAvailableEnvironments();
  if (!availableEnvironments.includes(environment)) {
    console.error(`Invalid environment: ${environment}`);
    console.log(`Available environments: ${availableEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  let mode: DashboardMode = 'unified';

  // Parse mode from remaining args
  const remainingArgs = args.slice(1);
  if (remainingArgs[0] === 'logs') {
    mode = 'logs';
  } else if (remainingArgs[0] === 'metrics') {
    mode = 'metrics';
  } else if (remainingArgs.length > 0 && remainingArgs[0] !== 'unified') {
    console.error(`Unknown argument: ${remainingArgs[0]}`);
    showHelp();
  }

  return { environment, mode };
}

function showHelp(): never {
  console.log('Semiont Watch - Interactive System Dashboard\n');
  console.log('Usage: semiont watch <environment> [mode]\n');
  
  console.log('Arguments:');
  console.log(`  <environment>  Environment to watch (${getAvailableEnvironments().join(', ')})`);
  console.log('  [mode]         Dashboard mode (default: unified)\n');
  
  console.log('Modes:');
  console.log('  unified   Unified dashboard with services, logs, and metrics (default)');
  console.log('  logs      Focus on log streaming');
  console.log('  metrics   Focus on performance metrics\n');
  
  
  console.log('Examples:');
  console.log('  semiont watch production               # Unified dashboard');
  console.log('  semiont watch staging logs             # All service logs');
  console.log('  semiont watch production metrics        # Performance dashboard\n');
  
  console.log('Controls:');
  console.log('  q         Quit');
  console.log('  r         Refresh now');
  console.log('  ↑↓        Scroll logs');
  console.log('  Space     Toggle auto-scroll');
  console.log('  g/G       Jump to top/bottom of logs');
  
  process.exit(0);
}

// Main execution
async function main() {
  try {
    const { environment, mode } = parseArgs();
    
    // Get refresh interval from environment variable if set
    const refreshInterval = process.env.SEMIONT_REFRESH_INTERVAL 
      ? parseInt(process.env.SEMIONT_REFRESH_INTERVAL, 10) 
      : 30;
    
    // Launch interactive dashboard
    render(
      <DashboardApp 
        mode={mode} 
        refreshInterval={refreshInterval}
        environment={environment}
      />
    );
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to start watch dashboard:', errorMessage);
    process.exit(1);
  }
}

// Only execute main if this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for use in watch.ts
export default DashboardApp;
export { DashboardMode };