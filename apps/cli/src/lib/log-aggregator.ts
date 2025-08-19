/**
 * Log Aggregator - Fetches and aggregates logs from various sources
 */

import { type ServiceDeploymentInfo } from './deployment-resolver.js';

export interface LogEntry {
  timestamp: Date;
  service: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  metadata?: Record<string, any>;
}

export interface LogFetchOptions {
  limit?: number;        // Number of log entries
  since?: Date;         // Start time
  until?: Date;         // End time
  level?: LogEntry['level'] | 'all';
  filter?: string;      // Text search
}

export abstract class LogFetcher {
  abstract fetchLogs(
    service: ServiceDeploymentInfo,
    options: LogFetchOptions
  ): Promise<LogEntry[]>;
  
  protected extractLogLevel(message: string): LogEntry['level'] {
    if (/ERROR|FATAL|CRITICAL/i.test(message)) return 'error';
    if (/WARN|WARNING/i.test(message)) return 'warn';
    if (/DEBUG|TRACE/i.test(message)) return 'debug';
    return 'info';
  }
}

export class LogAggregator {
  private fetchers: Map<string, LogFetcher> = new Map();
  
  constructor(private environment: string, private region?: string) {
    // Fetchers will be registered as they're implemented
  }
  
  registerFetcher(type: string, fetcher: LogFetcher): void {
    this.fetchers.set(type, fetcher);
  }
  
  async fetchRecentLogs(
    services: ServiceDeploymentInfo[],
    options: LogFetchOptions = {}
  ): Promise<LogEntry[]> {
    const allLogs: LogEntry[] = [];
    
    // Set default options
    const fetchOptions: LogFetchOptions = {
      limit: 10,  // 10 entries per service
      since: new Date(Date.now() - 5 * 60 * 1000), // Last 5 minutes
      ...options,
    };
    
    // Fetch logs from each service in parallel
    const promises = services.map(async service => {
      let fetcherType = service.deploymentType;
      
      // Special case for AWS RDS
      if (service.deploymentType === 'aws' && service.name === 'database') {
        fetcherType = 'rds';
      }
      
      const fetcher = this.fetchers.get(fetcherType);
      
      if (fetcher) {
        try {
          return await fetcher.fetchLogs(service, fetchOptions);
        } catch (error) {
          console.error(`Failed to fetch logs for ${service.name}:`, error);
          return [];
        }
      }
      return [];
    });
    
    const results = await Promise.all(promises);
    results.forEach(logs => allLogs.push(...logs));
    
    // Filter by level if specified
    let filteredLogs = allLogs;
    if (options.level && options.level !== 'all') {
      filteredLogs = allLogs.filter(log => log.level === options.level);
    }
    
    // Filter by text if specified
    if (options.filter) {
      const filterLower = options.filter.toLowerCase();
      filteredLogs = filteredLogs.filter(log => 
        log.message.toLowerCase().includes(filterLower)
      );
    }
    
    // Sort by timestamp (newest first)
    filteredLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    // Limit total results
    return filteredLogs.slice(0, options.limit || 50);
  }
  
  formatLogsForDisplay(logs: LogEntry[]): string {
    if (logs.length === 0) {
      return '  No recent logs found';
    }
    
    const colors = {
      reset: '\x1b[0m',
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      white: '\x1b[37m'
    };
    
    return logs.map(log => {
      const timestamp = log.timestamp.toISOString().substring(11, 19); // HH:MM:SS
      const levelIcon = this.getLevelIcon(log.level);
      const levelColor = this.getLevelColor(log.level, colors);
      
      // Truncate long messages
      const maxLength = 120;
      const message = log.message.length > maxLength 
        ? log.message.substring(0, maxLength - 3) + '...'
        : log.message;
      
      return `  ${colors.dim}${timestamp}${colors.reset} ${levelColor}${levelIcon}${colors.reset} ${colors.cyan}[${log.service}]${colors.reset} ${message}`;
    }).join('\n');
  }
  
  private getLevelIcon(level: LogEntry['level']): string {
    switch (level) {
      case 'error': return '[ERR]';
      case 'warn': return '[WRN]';
      case 'debug': return '[DBG]';
      default: return '[INF]';
    }
  }
  
  private getLevelColor(level: LogEntry['level'], colors: any): string {
    switch (level) {
      case 'error': return colors.red;
      case 'warn': return colors.yellow;
      case 'debug': return colors.dim;
      default: return '';
    }
  }
}