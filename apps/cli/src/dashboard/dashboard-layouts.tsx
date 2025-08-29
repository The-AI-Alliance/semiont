/**
 * Dashboard Layouts for Watch Command
 * 
 * React components that combine dashboard components into full-screen layouts
 */

import React, { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { 
  ServicePanel, 
  LogViewer, 
  MetricsPanel, 
  RefreshIndicator,
  ServiceStatus,
  LogEntry,
  MetricData
} from '../dashboard/dashboard-components.js';

// Dashboard data interfaces
export interface DashboardData {
  services: ServiceStatus[];
  logs: LogEntry[];
  metrics: MetricData[];
  lastUpdate: Date;
  isRefreshing: boolean;
}

// Main unified dashboard layout
export const UnifiedDashboard: React.FC<{
  data: DashboardData;
  refreshInterval?: number;
}> = ({ data, refreshInterval = 30 }) => {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows || 24;
  const terminalWidth = stdout?.columns || 80;

  // Calculate layout dimensions
  const headerHeight = 3;
  const footerHeight = 2;
  const contentHeight = terminalHeight - headerHeight - footerHeight;
  
  // Split content into panels
  const leftPanelWidth = Math.floor(terminalWidth * 0.4);
  const rightPanelWidth = terminalWidth - leftPanelWidth - 1;
  const topPanelHeight = Math.floor(contentHeight * 0.6);
  const bottomPanelHeight = contentHeight - topPanelHeight;

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Header */}
      <Box flexDirection="column" height={headerHeight} borderStyle="single" borderBottom>
        <Box justifyContent="space-between" paddingX={1}>
          <Text bold color="cyan">Semiont System Dashboard</Text>
          <RefreshIndicator 
            lastUpdate={data.lastUpdate}
            isRefreshing={data.isRefreshing}
            interval={refreshInterval}
          />
        </Box>
        <Box paddingX={1}>
          <Text color="gray">
            Press 'q' to quit, 'r' to refresh, '1-4' to switch panels (refresh every {refreshInterval}s)
          </Text>
        </Box>
      </Box>

      {/* Main content area */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left column */}
        <Box flexDirection="column" width={leftPanelWidth} borderStyle="single" borderRight>
          {/* Services panel */}
          <Box height={topPanelHeight} padding={1} borderBottom>
            <ServicePanel 
              services={data.services}
              title="Services Status"
            />
          </Box>
          
          {/* Metrics panel */}
          <Box height={bottomPanelHeight} padding={1}>
            <MetricsPanel 
              metrics={data.metrics}
              title="Key Metrics"
              columns={1}
            />
          </Box>
        </Box>

        {/* Right column - Logs */}
        <Box width={rightPanelWidth} padding={1}>
          <LogViewer 
            logs={data.logs}
            height={contentHeight - 2}
            title="Live Logs"
            showTimestamps={true}
          />
        </Box>
      </Box>

      {/* Footer */}
      <Box height={footerHeight} borderStyle="single" borderTop paddingX={1} paddingY={0}>
        <Box justifyContent="space-between" alignItems="center">
          <Text color="gray">
            ↑↓ Scroll logs • Space Toggle auto-scroll • g/G Top/Bottom
          </Text>
          <Text color="gray">
            Services: {data.services.filter(s => s.status === 'healthy').length} OK, {' '}
            {data.services.filter(s => s.status === 'unhealthy').length} Failed, {' '}
            {data.services.filter(s => s.status === 'warning').length} Warning
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

// Focused log view for `watch logs` mode
export const LogsOnlyDashboard: React.FC<{
  logs: LogEntry[];
  services: ServiceStatus[];
  title?: string;
  serviceFilter?: string[];
}> = ({ logs, services, title = "Container Logs", serviceFilter }) => {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows || 24;
  
  const headerHeight = 4;
  const footerHeight = 2;
  const logHeight = terminalHeight - headerHeight - footerHeight;

  const filteredServices = serviceFilter 
    ? services.filter(s => serviceFilter.includes(s.name))
    : services;

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Header with service status */}
      <Box flexDirection="column" height={headerHeight} borderStyle="single" borderBottom>
        <Box paddingX={1} paddingY={0}>
          <Text bold color="cyan">{title}</Text>
        </Box>
        <Box paddingX={1}>
          <ServicePanel 
            services={filteredServices}
            title="Services"
          />
        </Box>
      </Box>

      {/* Logs */}
      <Box flexGrow={1} padding={1}>
        <LogViewer 
          logs={logs}
          height={logHeight}
          title="Live Stream"
          showTimestamps={true}
          {...(serviceFilter ? { serviceFilter } : {})}
        />
      </Box>

      {/* Footer */}
      <Box height={footerHeight} borderStyle="single" borderTop paddingX={1}>
        <Text color="gray">
          Following logs in real-time • Ctrl+C to stop • ↑↓ to scroll
        </Text>
      </Box>
    </Box>
  );
};

// Focused metrics view for `watch metrics` mode  
export const MetricsOnlyDashboard: React.FC<{
  metrics: MetricData[];
  services: ServiceStatus[];
  title?: string;
}> = ({ metrics, services, title = "Performance Metrics" }) => {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows || 24;
  
  const headerHeight = 3;
  const footerHeight = 2;
  const contentHeight = terminalHeight - headerHeight - footerHeight;
  
  const servicesHeight = Math.min(services.length + 2, Math.floor(contentHeight * 0.3));
  const metricsHeight = contentHeight - servicesHeight;

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Header */}
      <Box height={headerHeight} borderStyle="single" borderBottom paddingX={1} paddingY={0}>
        <Text bold color="cyan">{title}</Text>
        <Text color="gray">Real-time performance monitoring</Text>
      </Box>

      {/* Services status */}
      <Box height={servicesHeight} padding={1} borderBottom>
        <ServicePanel 
          services={services}
          title="Services Health"
        />
      </Box>

      {/* Metrics */}
      <Box height={metricsHeight} padding={1}>
        <MetricsPanel 
          metrics={metrics}
          title="Performance Data"
          columns={3}
        />
      </Box>

      {/* Footer */}
      <Box height={footerHeight} borderStyle="single" borderTop paddingX={1}>
        <Text color="gray">
          Refreshing every 30 seconds • Press 'r' to refresh now • 'q' to quit
        </Text>
      </Box>
    </Box>
  );
};

// Compact dashboard for smaller terminals
export const CompactDashboard: React.FC<{
  data: DashboardData;
  refreshInterval?: number;
}> = ({ data, refreshInterval = 30 }) => {
  const [currentPanel, setCurrentPanel] = useState<'services' | 'logs' | 'metrics'>('services');
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows || 24;
  
  const headerHeight = 2;
  const footerHeight = 2;
  const contentHeight = terminalHeight - headerHeight - footerHeight;

  // Panel switching with keyboard
  useInput((input: string) => {
    if (input === '1') setCurrentPanel('services');
    else if (input === '2') setCurrentPanel('logs');
    else if (input === '3') setCurrentPanel('metrics');
  });

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Header */}
      <Box height={headerHeight} borderStyle="single" borderBottom paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            Semiont Dashboard - {currentPanel.toUpperCase()}
          </Text>
          <RefreshIndicator 
            lastUpdate={data.lastUpdate}
            isRefreshing={data.isRefreshing}
            interval={refreshInterval}
          />
        </Box>
      </Box>

      {/* Content */}
      <Box height={contentHeight} padding={1}>
        {currentPanel === 'services' && (
          <ServicePanel 
            services={data.services}
            title="Services Status"
          />
        )}
        
        {currentPanel === 'logs' && (
          <LogViewer 
            logs={data.logs}
            height={contentHeight - 2}
            title="Recent Logs"
            showTimestamps={true}
          />
        )}
        
        {currentPanel === 'metrics' && (
          <MetricsPanel 
            metrics={data.metrics}
            title="System Metrics"
            columns={2}
          />
        )}
      </Box>

      {/* Footer */}
      <Box height={footerHeight} borderStyle="single" borderTop paddingX={1}>
        <Text color="gray">
          1:Services 2:Logs 3:Metrics • q:Quit r:Refresh • 
          Panel: [{currentPanel === 'services' ? '●' : '○'}-{currentPanel === 'logs' ? '●' : '○'}-{currentPanel === 'metrics' ? '●' : '○'}]
        </Text>
      </Box>
    </Box>
  );
};

// Hook for keyboard input handling
import { useInput } from 'ink';