/**
 * Shared Dashboard Components for Ink-based CLI interfaces
 * 
 * Reusable React components for building rich terminal dashboards
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

// Types
export interface ServiceStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'warning' | 'unknown';
  details?: string;
  lastUpdated?: Date;
  // ECS-specific details
  revision?: number;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  taskDefinition?: string;
  cluster?: string;
  deploymentStatus?: string;
  imageUri?: string;
  // Service metrics
  cpuUtilization?: number;
  memoryUtilization?: number;
  requestCount?: number;
  errorRate?: number;
  // EFS-specific details
  storageUsedBytes?: number;
  storageAvailableBytes?: number;
  storageTotalBytes?: number;
  storageUsedPercent?: number;
  throughputUtilization?: number;
  clientConnections?: number;
  // AWS Console links data
  awsRegion?: string;
  ecsServiceName?: string;
  ecsClusterName?: string;
  rdsInstanceId?: string;
  efsFileSystemId?: string;
  albArn?: string;
  loadBalancerDns?: string;
  wafWebAclId?: string;
  route53ZoneId?: string;
  cloudFormationStackName?: string;
  logGroupName?: string;
}

export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  service: string;
  message: string;
}

export interface MetricData {
  name: string;
  value: number;
  unit?: string;
  trend?: 'up' | 'down' | 'stable';
}

// Color scheme
const colors = {
  healthy: 'green',
  unhealthy: 'red', 
  warning: 'yellow',
  unknown: 'gray',
  info: 'blue',
  warn: 'yellow',
  error: 'red',
  debug: 'gray',
} as const;

// Status indicator component
export const StatusIndicator: React.FC<{ status: ServiceStatus['status']; size?: 'small' | 'normal' }> = ({ 
  status, 
  size = 'normal' 
}) => {
  const icons = {
    small: { healthy: '●', unhealthy: '●', warning: '●', unknown: '●' },
    normal: { healthy: '✅', unhealthy: '❌', warning: '⚠️', unknown: '❓' }
  };
  
  return (
    <Text color={colors[status]}>
      {icons[size][status]}
    </Text>
  );
};

// Service panel for displaying service status
export const ServicePanel: React.FC<{ 
  services: ServiceStatus[];
  title?: string;
}> = ({ 
  services, 
  title = "Services"
}) => {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{title}</Text>
      </Box>
      {services.length === 0 ? (
        <Text color="gray">No services to monitor</Text>
      ) : (
        services.map((service, index) => (
          <Box key={index} marginBottom={1}>
            <Box marginRight={1}>
              <StatusIndicator status={service.status} size="small" />
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Box>
                <Text bold>{service.name}</Text>
                <Text color={colors[service.status]}> {service.status}</Text>
                {service.revision && (
                  <Text color="cyan"> rev:{service.revision}</Text>
                )}
                {service.runningCount !== undefined && service.desiredCount !== undefined && (
                  <Text color="gray"> [{service.runningCount}/{service.desiredCount}]</Text>
                )}
              </Box>
              {service.details && (
                <Text color="gray" dimColor>  {service.details}</Text>
              )}
              {/* Always show deployment status if there's an active deployment */}
              {service.deploymentStatus && service.deploymentStatus.includes('🔄') && (
                <Text color="yellow">  {service.deploymentStatus}</Text>
              )}
              {/* Show stable deployment status */}
              {service.deploymentStatus && !service.deploymentStatus.includes('🔄') && (
                <Text color="gray" dimColor>  Deployment: {service.deploymentStatus}</Text>
              )}
              {service.taskDefinition && (
                <Text color="gray" dimColor>  Task: {service.taskDefinition}</Text>
              )}
              {service.lastUpdated && (
                <Text color="gray" dimColor>  Updated: {service.lastUpdated.toLocaleTimeString()}</Text>
              )}
              {/* ALB and WAF Information */}
              {service.loadBalancerDns && (
                <Text color="cyan">  ALB: {service.loadBalancerDns}</Text>
              )}
              {service.wafWebAclId && (
                <Text color="green">  WAF: Protected ✓</Text>
              )}
              {/* EFS Storage Metrics */}
              {service.name === 'Filesystem' && service.storageTotalBytes && (
                <>
                  <Text color="cyan">  Storage:</Text>
                  {service.storageUsedBytes !== undefined && service.storageTotalBytes && (
                    <Text color="gray">
                      {'    '}Used: {formatBytes(service.storageUsedBytes)} / {formatBytes(service.storageTotalBytes)} 
                      {service.storageUsedPercent !== undefined && (
                        <Text color={
                          service.storageUsedPercent > 90 ? 'red' :
                          service.storageUsedPercent > 70 ? 'yellow' : 'green'
                        }> ({service.storageUsedPercent.toFixed(1)}%)</Text>
                      )}
                    </Text>
                  )}
                  {service.storageAvailableBytes !== undefined && (
                    <Text color="gray">    Available: {formatBytes(service.storageAvailableBytes)}</Text>
                  )}
                  {service.throughputUtilization !== undefined && (
                    <Text color="gray">    Throughput: {service.throughputUtilization.toFixed(1)}%</Text>
                  )}
                  {service.clientConnections !== undefined && (
                    <Text color="gray">    Connections: {service.clientConnections}</Text>
                  )}
                </>
              )}
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
};

// Helper function to format bytes
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

// Scrollable log viewer with filtering
export const LogViewer: React.FC<{
  logs: LogEntry[];
  height?: number;
  showTimestamps?: boolean;
  levelFilter?: LogEntry['level'][];
  serviceFilter?: string[];
  title?: string;
}> = ({ 
  logs, 
  height = 10, 
  showTimestamps = true, 
  levelFilter,
  serviceFilter,
  title = "Logs"
}) => {
  const [scrollPosition, setScrollPosition] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  // Filter logs
  const filteredLogs = logs.filter(log => {
    if (levelFilter && !levelFilter.includes(log.level)) return false;
    if (serviceFilter && !serviceFilter.includes(log.service)) return false;
    return true;
  });

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && filteredLogs.length > height) {
      setScrollPosition(filteredLogs.length - height);
    }
  }, [filteredLogs.length, height, autoScroll]);

  // Handle keyboard input for scrolling
  useInput((input: string, key: any) => {
    if (key.upArrow && scrollPosition > 0) {
      setScrollPosition(scrollPosition - 1);
      setAutoScroll(false);
    } else if (key.downArrow && scrollPosition < filteredLogs.length - height) {
      setScrollPosition(scrollPosition + 1);
      if (scrollPosition + 1 >= filteredLogs.length - height) {
        setAutoScroll(true);
      }
    } else if (input === 'g') {
      // 'g' to go to top
      setScrollPosition(0);
      setAutoScroll(false);
    } else if (input === 'G') {
      // 'G' to go to bottom
      setScrollPosition(Math.max(0, filteredLogs.length - height));
      setAutoScroll(true);
    } else if (input === ' ') {
      // Space to toggle auto-scroll
      setAutoScroll(!autoScroll);
    }
  });

  const visibleLogs = filteredLogs.slice(scrollPosition, scrollPosition + height);
  const hasMore = filteredLogs.length > height;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">{title}</Text>
        {hasMore && (
          <Text color="gray">
            {scrollPosition + 1}-{scrollPosition + visibleLogs.length} of {filteredLogs.length}
            {autoScroll && " (auto-scroll)"}
          </Text>
        )}
      </Box>
      
      <Box flexDirection="column" height={height}>
        {visibleLogs.map((log, index) => {
          // Format the log entry with proper spacing
          const timestamp = showTimestamps ? `[${log.timestamp.toLocaleTimeString()}]` : '';
          const service = log.service.padEnd(8);
          const level = log.level.toUpperCase().padEnd(5);
          
          return (
            <Box key={scrollPosition + index}>
              {showTimestamps && (
                <Text color="gray" dimColor>
                  {timestamp.padEnd(11)}
                </Text>
              )}
              <Text color="gray">
                {service.padEnd(9)}
              </Text>
              <Text color={colors[log.level]}>
                {level.padEnd(6)}
              </Text>
              <Text>{log.message}</Text>
            </Box>
          );
        })}
      </Box>
      
      {hasMore && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Use ↑↓ to scroll, 'g'/'G' for top/bottom, Space to toggle auto-scroll
          </Text>
        </Box>
      )}
    </Box>
  );
};

// Metrics display with simple trend indicators
export const MetricsPanel: React.FC<{
  metrics: MetricData[];
  title?: string;
  columns?: number;
}> = ({ 
  metrics, 
  title = "Metrics"
}) => {
  const trendIndicators = {
    up: '↑',
    down: '↓', 
    stable: '→'
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{title}</Text>
      </Box>
      {metrics.length === 0 ? (
        <Text color="gray">No metrics available</Text>
      ) : (
        <Box flexDirection="column">
          {metrics.map((metric, index) => (
            <Box key={index} marginBottom={0}>
              <Box>
                <Text color="gray">{metric.name}:</Text>
              </Box>
              <Box marginLeft={2}>
                <Text color="green" bold>
                  {metric.value}{metric.unit || ''}
                </Text>
                {metric.trend && (
                  <Text color={metric.trend === 'up' ? 'green' : metric.trend === 'down' ? 'red' : 'yellow'}>
                    {' '}{trendIndicators[metric.trend]}
                  </Text>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

// Refresh indicator showing last update time
export const RefreshIndicator: React.FC<{
  lastUpdate: Date;
  isRefreshing?: boolean;
  interval?: number;
}> = ({ 
  lastUpdate, 
  isRefreshing = false, 
  interval 
}) => {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const secondsAgo = Math.floor((now.getTime() - lastUpdate.getTime()) / 1000);
  const timeAgo = secondsAgo < 60 
    ? `${secondsAgo}s ago`
    : `${Math.floor(secondsAgo / 60)}m ${secondsAgo % 60}s ago`;

  return (
    <Box>
      <Text color="gray">
        Last updated: {timeAgo}
        {isRefreshing && " 🔄"}
        {interval && ` (refresh every ${interval}s)`}
      </Text>
    </Box>
  );
};

// Simple table component for structured data
export const SimpleTable: React.FC<{
  headers: string[];
  rows: string[][];
  title?: string;
}> = ({ 
  headers, 
  rows, 
  title 
}) => {
  // Calculate column widths
  const columnWidths = headers.map((header, colIndex) => {
    const maxContentWidth = Math.max(
      header.length,
      ...rows.map(row => (row[colIndex] || '').length)
    );
    return Math.min(maxContentWidth + 2, 30); // Max width of 30 chars
  });

  return (
    <Box flexDirection="column">
      {title && (
        <Box marginBottom={1}>
          <Text bold color="cyan">{title}</Text>
        </Box>
      )}
      
      {/* Headers */}
      <Box>
        {headers.map((header, index) => (
          <Box key={index} {...(columnWidths[index] !== undefined ? { width: columnWidths[index] } : {})}>
            <Text bold color="blue">{header.padEnd(columnWidths[index]! - 1)}</Text>
          </Box>
        ))}
      </Box>
      
      {/* Separator */}
      <Box marginBottom={1}>
        <Text color="gray">
          {columnWidths.map(width => '─'.repeat(width - 1)).join('┼')}
        </Text>
      </Box>
      
      {/* Rows */}
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex}>
          {row.map((cell, colIndex) => (
            <Box key={colIndex} {...(columnWidths[colIndex] !== undefined ? { width: columnWidths[colIndex] } : {})}>
              <Text>{(cell || '').padEnd(columnWidths[colIndex]! - 1)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
};