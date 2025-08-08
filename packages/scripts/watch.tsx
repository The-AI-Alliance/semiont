/**
 * Semiont Watch Command - Interactive Dashboard
 * 
 * Provides real-time monitoring of services, logs, and metrics through
 * a modern terminal-based dashboard interface built with React/Ink.
 */

import React, { useState, useEffect } from 'react';
import { render, useApp, useInput } from 'ink';
import { ServiceType, isServiceType } from './lib/types';
import { DashboardDataSource } from './lib/dashboard-data';
import { UnifiedDashboard, LogsOnlyDashboard, MetricsOnlyDashboard, DashboardData } from './lib/dashboard-layouts';

// Dashboard mode types
type DashboardMode = 'unified' | 'logs' | 'metrics';

// Main Dashboard App Component
const DashboardApp: React.FC<{ 
  mode: DashboardMode; 
  service?: ServiceType; 
  refreshInterval?: number 
}> = ({ mode, service, refreshInterval = 30 }) => {
  const [data, setData] = useState<DashboardData>({
    services: [],
    logs: [],
    metrics: [],
    lastUpdate: new Date(),
    isRefreshing: false
  });
  const [dataSource] = useState(() => new DashboardDataSource());
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
          serviceFilter={service && service !== 'both' ? [service] : undefined}
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

// Simplified argument parsing
function parseArgs(): { mode: DashboardMode; service?: ServiceType } {
  const args = process.argv.slice(2);
  let mode: DashboardMode = 'unified';
  let service: ServiceType | undefined;

  // Parse mode
  if (args[0] === 'logs') {
    mode = 'logs';
    if (args[1] && isServiceType(args[1])) {
      service = args[1];
    }
  } else if (args[0] === 'metrics') {
    mode = 'metrics';
    if (args[1] && isServiceType(args[1])) {
      service = args[1];
    }
  } else if (args[0] && isServiceType(args[0])) {
    // Service specified first
    service = args[0];
    if (args[1] === 'logs') {
      mode = 'logs';
    } else if (args[1] === 'metrics') {
      mode = 'metrics';
    }
  } else if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
  } else if (args.length > 0 && args[0] !== 'unified') {
    console.error(`Unknown argument: ${args[0]}`);
    showHelp();
  }

  return { mode, service };
}

function showHelp(): never {
  console.log('Semiont Watch - Interactive System Dashboard\n');
  console.log('Usage: semiont watch [mode] [service]\n');
  
  console.log('Modes:');
  console.log('  (none)    Unified dashboard with services, logs, and metrics (default)');
  console.log('  logs      Focus on log streaming');
  console.log('  metrics   Focus on performance metrics\n');
  
  console.log('Services:');
  console.log('  frontend  Filter to frontend service only');
  console.log('  backend   Filter to backend service only');
  console.log('  (none)    Show all services\n');
  
  console.log('Examples:');
  console.log('  semiont watch              # Unified dashboard');
  console.log('  semiont watch logs          # All service logs');
  console.log('  semiont watch logs frontend # Frontend logs only');
  console.log('  semiont watch metrics       # Performance dashboard');
  console.log('  semiont watch frontend      # Frontend unified view\n');
  
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
    const { mode, service } = parseArgs();
    
    // Launch interactive dashboard
    render(
      <DashboardApp 
        mode={mode} 
        service={service} 
        refreshInterval={30} 
      />
    );
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to start watch dashboard:', errorMessage);
    process.exit(1);
  }
}

// Execute
main();