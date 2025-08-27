/**
 * Semiont Watch Command - Interactive Dashboard
 * 
 * Provides real-time monitoring of services, logs, and metrics through
 * a modern terminal-based dashboard interface built with React/Ink.
 */

import React, { useState, useEffect } from 'react';
import { render, useApp, useInput } from 'ink';
import { ServiceType, isServiceType } from '../lib/types.js';
import { DashboardDataSource, DashboardData } from '../lib/dashboard-data.js';
import { UnifiedDashboard, LogsOnlyDashboard, MetricsOnlyDashboard } from '../lib/dashboard-layouts.js';

// Dashboard mode types
type DashboardMode = 'unified' | 'logs' | 'metrics';

// Main Dashboard App Component
const DashboardApp: React.FC<{ 
  mode: DashboardMode; 
  service?: ServiceType; 
  refreshInterval?: number;
  environment: string;
}> = ({ mode, service, refreshInterval = 30, environment }) => {
  const [data, setData] = useState<DashboardData>({
    services: [],
    logs: [],
    metrics: [],
    lastUpdate: new Date(),
    isRefreshing: false
  });
  const [dataSource] = useState(() => new DashboardDataSource(environment));
  const { exit } = useApp();

  // Global keyboard shortcuts
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    } else if (input === 'r') {
      refreshData();
    }
  });

  // Data refreshing
  const refreshData = async () => {
    setData(prev => ({ ...prev, isRefreshing: true }));
    try {
      const newData = await dataSource.getDashboardData();
      setData(newData);
    } catch (error) {
      console.error('Failed to refresh dashboard data:', error);
    } finally {
      setData(prev => ({ ...prev, isRefreshing: false }));
    }
  };

  // Initial load and periodic refresh
  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [refreshInterval]);

  // Filter data by service if specified
  const filteredLogs = service && service !== 'both' 
    ? data.logs.filter(log => log.service === service)
    : data.logs;

  const filteredServices = service && service !== 'both'
    ? data.services.filter(s => s.name.toLowerCase().includes(service))
    : data.services;

  // Render appropriate dashboard layout
  switch (mode) {
    case 'unified':
      return <UnifiedDashboard data={data} refreshInterval={refreshInterval} />;
      
    case 'logs':
      return (
        <LogsOnlyDashboard 
          logs={filteredLogs}
          services={filteredServices}
          title={service ? `${service.charAt(0).toUpperCase() + service.slice(1)} Logs` : 'All Service Logs'}
          {...(service && service !== 'both' && { serviceFilter: [service] })}
        />
      );
      
    case 'metrics':
      return (
        <MetricsOnlyDashboard 
          metrics={data.metrics}
          services={data.services}
          title="Performance Metrics"
        />
      );
      
    default:
      return <UnifiedDashboard data={data} refreshInterval={refreshInterval} />;
  }
};

import { getAvailableEnvironments } from '../lib/platform-resolver.js';

// Argument parsing with environment support
function parseArgs(): { environment: string; mode: DashboardMode; service?: ServiceType } {
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
  let service: ServiceType | undefined;

  // Parse mode from remaining args
  const remainingArgs = args.slice(1);
  if (remainingArgs[0] === 'logs') {
    mode = 'logs';
    if (remainingArgs[1] && isServiceType(remainingArgs[1])) {
      service = remainingArgs[1];
    }
  } else if (remainingArgs[0] === 'metrics') {
    mode = 'metrics';
    if (remainingArgs[1] && isServiceType(remainingArgs[1])) {
      service = remainingArgs[1];
    }
  } else if (remainingArgs[0] && isServiceType(remainingArgs[0])) {
    // Service specified first
    service = remainingArgs[0];
    if (remainingArgs[1] === 'logs') {
      mode = 'logs';
    } else if (remainingArgs[1] === 'metrics') {
      mode = 'metrics';
    }
  } else if (remainingArgs.length > 0 && remainingArgs[0] !== 'unified') {
    console.error(`Unknown argument: ${remainingArgs[0]}`);
    showHelp();
  }

  return { environment, mode, ...(service && { service }) };
}

function showHelp(): never {
  console.log('Semiont Watch - Interactive System Dashboard\n');
  console.log('Usage: semiont watch <environment> [mode] [service]\n');
  
  console.log('Arguments:');
  console.log(`  <environment>  Environment to watch (${getAvailableEnvironments().join(', ')})`);
  console.log('  [mode]         Dashboard mode (default: unified)');
  console.log('  [service]      Service filter (default: all)\n');
  
  console.log('Modes:');
  console.log('  unified   Unified dashboard with services, logs, and metrics (default)');
  console.log('  logs      Focus on log streaming');
  console.log('  metrics   Focus on performance metrics\n');
  
  console.log('Services:');
  console.log('  frontend  Filter to frontend service only');
  console.log('  backend   Filter to backend service only');
  console.log('  (none)    Show all services\n');
  
  console.log('Examples:');
  console.log('  semiont watch production               # Unified dashboard');
  console.log('  semiont watch staging logs             # All service logs');
  console.log('  semiont watch development logs frontend # Frontend logs only');
  console.log('  semiont watch production metrics        # Performance dashboard');
  console.log('  semiont watch staging frontend          # Frontend unified view\n');
  
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
    const { environment, mode, service } = parseArgs();
    
    // Get refresh interval from environment variable if set
    const refreshInterval = process.env.SEMIONT_REFRESH_INTERVAL 
      ? parseInt(process.env.SEMIONT_REFRESH_INTERVAL, 10) 
      : 30;
    
    // Launch interactive dashboard
    render(
      <DashboardApp 
        mode={mode} 
        {...(service && { service })}
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